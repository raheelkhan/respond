import { PassThrough, Readable } from 'node:stream';
import { S3Event } from 'aws-lambda';
import { DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import archiver from 'archiver';

const SOURCE_PREFIX = 'incoming/';
const ARCHIVE_PREFIX = 'archive/';

const s3 = new S3Client({});

/**
 * Invoked by S3 whenever a `.json` object is created under `incoming/`.
 *
 * Streams the object through a ZIP archive written to `archive/` under the
 * same relative key, then deletes the original. Nothing is buffered in full:
 * GetObject's body feeds archiver, whose output is consumed by a
 * multipart Upload.
 *
 * Event doc: https://docs.aws.amazon.com/lambda/latest/dg/with-s3.html
 * @param {Object} event - S3 ObjectCreated event
 */
export const lambdaHandler = async (event: S3Event): Promise<void> => {
    for (const record of event.Records) {
        const bucket = record.s3.bucket.name;

        // Object key may have spaces or unicode non-ASCII characters.
        const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
        const archiveKey = `${ARCHIVE_PREFIX}${key.slice(SOURCE_PREFIX.length)}.zip`;
        const entryName = key.slice(key.lastIndexOf('/') + 1);

        const { Body } = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!(Body instanceof Readable)) {
            throw new Error(`Unexpected body type for s3://${bucket}/${key}`);
        }

        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.append(Body, { name: entryName });

        // archiver extends Transform from the `readable-stream` package, which
        // fails lib-storage's `instanceof node:stream.Readable` check. Piping
        // through a native PassThrough gives Upload a stream it accepts.
        const body = new PassThrough();
        archive.on('error', (err) => body.destroy(err));
        archive.pipe(body);

        const upload = new Upload({
            client: s3,
            params: {
                Bucket: bucket,
                Key: archiveKey,
                Body: body,
                ContentType: 'application/zip',
            },
        });

        await Promise.all([archive.finalize(), upload.done()]);

        // Only once the archive is durably stored do we drop the original.
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));

        console.log({
            message: 'compressed object',
            source: `s3://${bucket}/${key}`,
            archive: `s3://${bucket}/${archiveKey}`,
            sourceBytes: record.s3.object.size,
            compressedBytes: archive.pointer(),
        });
    }
};
