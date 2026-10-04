# S3 object compression

A Lambda that zips JSON files as they land in S3.

Drop a `.json` into `incoming/`, the function streams it into a ZIP under
`archive/` and deletes the original.

## Contents

- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Deploy](#deploy)
- [Test](#test)
- [Rollback](#rollback)
- [Cost analysis](#cost-analysis)
  - [Why 1769 MB](#why-1769-mb)
  - [Storage](#storage)
- [Saving more](#saving-more)
- [If it has to run in AWS](#if-it-has-to-run-in-aws)
- [What I would actually do](#what-i-would-actually-do)

## Architecture

Everything lives in `template.yaml` and deploys as one CloudFormation stack.

- **S3 bucket** `<account-id>-respond-io-source-bucket`. Uploads go to
  `incoming/`, archives to `archive/`.
- **Lambda** Node.js 24, container image, private subnets of its own VPC.
- **S3 gateway endpoint** the only route out. No NAT, no internet gateway.
- **Alias `live`** each deploy publishes a version and moves the alias, so
  rollback is one `update-alias` call.

The archive goes back into the bucket that triggers the function, so the
event filter is scoped to `prefix: incoming/` and `suffix: .json`. A `.zip`
in `archive/` can't match it. The IAM policy splits the same way: read and
delete on `incoming/*`, write on `archive/*`. Two separate guards, because
a self-triggering Lambda at this volume would be an expensive mistake.


## Prerequisites

AWS SAM CLI, Docker, Node.js 24, AWS credentials.

## Deploy

```sh
cd zip-function && npm install && cd ..
sam build
sam deploy --profile <your-profile>
```

## Test

```sh
./scripts/trigger.sh --profile <your-profile>
```

Uploads a sample file, waits for the archive, prints the bucket and the
logs. It deletes nothing, so you can go and look.

`--clean` empties the bucket and clears the log streams.

Unit tests: `cd zip-function && npm test`.

## Rollback

```sh
aws lambda update-alias \
  --function-name <function-name> \
  --name live \
  --function-version <previous-version>
```

The S3 notification points at the alias, so this takes effect immediately.
Versions survive stack updates.

## Cost analysis

At 1,000,000 files an hour (730 million a month) of roughly 10 MB each, in
`us-east-1`, on S3 Standard.

| What we pay for | Unit price | Calculation | Per month |
|---|---|---|---|
| Lambda invocations | $0.20 per 1M | 730M requests | $146 |
| Lambda runtime | $0.0000166667 per GB-s | 1.728 GB x 0.81 s = 1.40 GB-s per file, x 730M | $16,983 |
| S3 PUT (write archive) | $0.005 per 1,000 | 730M requests | $3,650 |
| S3 GET (read source) | $0.0004 per 1,000 | 730M requests | $292 |
| S3 DELETE (remove source) | free | 730M requests | $0 |
| S3 storage | ~$0.022 per GB | 730M x 1.98 MB = 1.29 PB | $28,897 |
| **Total** | | | **~$50k** |

Networking is free. The gateway endpoint costs nothing, there's no NAT, and
S3 traffic stays in-region. Logs and the ECR image are a few dollars.

### Why 1769 MB

Lambda bills memory multiplied by time, and memory also buys CPU. Zipping is
CPU work, so a bigger function finishes faster and the bill barely moves.

I ran a real 10 MB file at three sizes:

| Memory | Time per file | Cost per month |
|---|---|---|
| 1024 MB | 2.05 s | $25,000 |
| **1769 MB** | **1.21 s** | **$25,300** |
| 3008 MB | 1.13 s | $40,400 |

1769 MB is where you get a full vCPU. Below it the function is starved and
just takes longer for the same money. Above it the memory sits idle while
the function waits on S3, and you pay for it.


### Storage

10 MB in, 2 MB out. A month of archives costs around $28,900. The same data
uncompressed would be about $150,000, so the compression saves roughly
$120,000 a month.

## Saving more

**Use a colder S3 tier.** The numbers above assume S3 Standard, which is
priced for frequent access. These are archives. Glacier or Deep Archive fits
what they're actually for, and storage is over half the bill. A lifecycle
rule, and the biggest saving on this list.

**Switch to arm64.** Graviton is about 20% cheaper per GB-second. Roughly
$3,400 a month for a one-line change.

**Batch files into one archive.** About $3,800 a month off invocations and
PUTs. Doesn't touch runtime, since the same bytes still get downloaded and
compressed, and it needs an aggregation layer. Most work, least return.

**Use tar.gz instead of zip.** A zip compresses each entry separately, so
batching into one zip buys nothing on size. A tar.gz compresses the batch as
a whole and would do better.

## If it has to run in AWS

Lambda is a poor fit here. Of the 810 ms billed per file, only about 360 ms
is compression. The rest is waiting on S3, and Lambda bills for the wait.

A worker with a thread pool doesn't idle like that. One thread zips while
another downloads.

So: S3 events to SQS, ECS tasks on EC2 pulling batches, several threads per
task. The actual work is about 73,000 vCPU-hours a month, which is roughly
144 vCPUs at 70% utilisation.

| Compute option | Per month |
|---|---|
| Lambda today | $17,129 |
| ECS on EC2 on-demand, plus SQS | $5,041 |
| ECS on EC2, 1 year savings plan | $3,728 |
| ECS on EC2, spot | $1,758 |

Spot is fine, the job is idempotent and SQS redelivers.

## What I would actually do

Compress on the on-premises server before uploading.

The files are produced there. The machine is already paid for, and zipping a
JSON file does not need a cloud instance. Compressing at source means
uploading 2 MB instead of 10 MB, and the whole pipeline in this repo stops
being necessary.

| | Per month |
|---|---|
| This solution, S3 Standard | ~$50,000 |
| Compress on-prem, S3 Standard | ~$28,900 |
| Compress on-prem, Glacier Instant Retrieval | ~$5,400 |
| Compress on-prem, Deep Archive | ~$1,300 |

No Lambda, no extra GET, PUT or DELETE, and 80% less upload bandwidth. What
remains is storage, and picking the right tier for it.
