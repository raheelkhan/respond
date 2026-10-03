#!/usr/bin/env bash
#
# Upload a sample object to incoming/ and show what the Lambda did with it.
# The manual "press the button" loop: deploy, run this, read the output.
#
# Usage: ./scripts/trigger.sh [--profile NAME] [--file PATH] [--key NAME]
#        ./scripts/trigger.sh --clean [--profile NAME]
#
#   --profile  AWS profile (falls back to AWS_PROFILE / default chain)
#   --file     payload to upload      (default: events/sample-result.json)
#   --key      key name under incoming/ (default: sample-<timestamp>.json)
#   --clean    empty the bucket and clear log streams, then exit
set -euo pipefail

PROFILE=""
FILE="$(dirname "$0")/../events/sample-result.json"
NAME=""
CLEAN=0

while [ $# -gt 0 ]; do
    case "$1" in
        --profile) PROFILE=$2; shift 2 ;;
        --profile=*) PROFILE=${1#*=}; shift ;;
        --file) FILE=$2; shift 2 ;;
        --file=*) FILE=${1#*=}; shift ;;
        --key) NAME=$2; shift 2 ;;
        --key=*) NAME=${1#*=}; shift ;;
        --clean) CLEAN=1; shift ;;
        -h|--help) sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

aws_() {
    if [ -n "$PROFILE" ]; then aws --profile "$PROFILE" "$@"; else aws "$@"; fi
}

log_group() {
    local fn
    fn=$(aws_ cloudformation describe-stack-resource --stack-name respond \
        --logical-resource-id ZipFunction \
        --query 'StackResourceDetail.PhysicalResourceId' --output text 2>/dev/null) || return 1
    echo "/aws/lambda/${fn}"
}

ACCOUNT=$(aws_ sts get-caller-identity --query Account --output text)
BUCKET="${ACCOUNT}-respond-io-source-bucket"

if [ "$CLEAN" -eq 1 ]; then
    echo "emptying s3://${BUCKET}"
    aws_ s3 rm "s3://${BUCKET}" --recursive

    if group=$(log_group); then
        echo "clearing streams in ${group}"
        streams=$(aws_ logs describe-log-streams --log-group-name "$group" \
            --query 'logStreams[].logStreamName' --output text 2>/dev/null) || streams=""
        if [ -z "$streams" ]; then
            echo "  (nothing to clear)"
        else
            for stream in $streams; do
                aws_ logs delete-log-stream --log-group-name "$group" \
                    --log-stream-name "$stream"
            done
        fi
    fi

    echo "clean"
    exit 0
fi

[ -f "$FILE" ] || { echo "no such file: $FILE" >&2; exit 1; }
[ -n "$NAME" ] || NAME="sample-$(date +%s).json"

SOURCE_KEY="incoming/${NAME}"
ARCHIVE_KEY="archive/${NAME}.zip"

echo "uploading $(wc -c < "$FILE" | tr -d ' ') bytes -> s3://${BUCKET}/${SOURCE_KEY}"
aws_ s3 cp "$FILE" "s3://${BUCKET}/${SOURCE_KEY}" --quiet

printf 'waiting for %s ' "$ARCHIVE_KEY"
for _ in $(seq 1 30); do
    if aws_ s3api head-object --bucket "$BUCKET" --key "$ARCHIVE_KEY" >/dev/null 2>&1; then
        echo " ok"
        break
    fi
    printf '.'
    sleep 2
done
echo

echo "bucket contents:"
aws_ s3 ls "s3://${BUCKET}" --recursive

echo
echo "recent logs:"
aws_ logs tail "$(log_group)" --since 5m --format short 2>/dev/null \
    || echo "  (no log group yet)"

echo
echo "nothing was deleted - clean up with:"
echo "  $0 --clean${PROFILE:+ --profile $PROFILE}"
