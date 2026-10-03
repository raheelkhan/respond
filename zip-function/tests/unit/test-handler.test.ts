import { Readable } from 'node:stream';
import { describe, expect, it, beforeEach, jest } from '@jest/globals';
import {
    DeleteObjectCommand,
    GetObjectCommand,
    PutObjectCommand,
    S3Client,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import AdmZip from 'adm-zip';
import { Context, S3Event } from 'aws-lambda';

import { lambdaHandler } from '../../app';

const s3Mock = mockClient(S3Client);

const BUCKET = 'test-bucket';
const CONTEXT = { awsRequestId: 'test-request-id', functionName: 'zip-function' } as Context;

const invoke = (e: S3Event) => lambdaHandler(e, CONTEXT);
const PAYLOAD = JSON.stringify({ frames: Array.from({ length: 500 }, (_, i) => i) });

const event = (key: string): S3Event =>
    ({
        Records: [
            {
                s3: {
                    bucket: { name: BUCKET },
                    object: { key, size: PAYLOAD.length },
                },
            },
        ],
    }) as S3Event;

/** Captures the bytes lib-storage uploads, in call order. */
const captureUploads = () => {
    const calls: { key: string; body: Buffer; contentType?: string }[] = [];
    s3Mock.on(PutObjectCommand).callsFake((input) => {
        calls.push({
            key: input.Key as string,
            body: Buffer.from(input.Body as Uint8Array),
            contentType: input.ContentType as string | undefined,
        });
        return { ETag: '"etag"' };
    });
    return calls;
};

beforeEach(() => {
    s3Mock.reset();
    s3Mock.on(GetObjectCommand).callsFake(() => ({ Body: Readable.from([PAYLOAD]) }));
    s3Mock.on(DeleteObjectCommand).resolves({});
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('lambdaHandler', () => {
    it('writes a real zip containing the source object', async () => {
        const uploads = captureUploads();

        await invoke(event('incoming/result.json'));

        expect(uploads).toHaveLength(1);
        expect(uploads[0].key).toBe('archive/result.json.zip');
        expect(uploads[0].contentType).toBe('application/zip');

        // Proves the bytes are a valid archive, not just that a call happened.
        expect(uploads[0].body.subarray(0, 2).toString()).toBe('PK');
        const entries = new AdmZip(uploads[0].body).getEntries();
        expect(entries.map((e) => e.entryName)).toEqual(['result.json']);
        expect(entries[0].getData().toString()).toBe(PAYLOAD);
    });

    it('compresses to fewer bytes than the source', async () => {
        const uploads = captureUploads();

        await invoke(event('incoming/result.json'));

        expect(uploads[0].body.length).toBeLessThan(PAYLOAD.length);
    });

    it('deletes the original only after the upload completes', async () => {
        const order: string[] = [];
        s3Mock.on(PutObjectCommand).callsFake(() => {
            order.push('put');
            return { ETag: '"etag"' };
        });
        s3Mock.on(DeleteObjectCommand).callsFake(() => {
            order.push('delete');
            return {};
        });

        await invoke(event('incoming/result.json'));

        expect(order).toEqual(['put', 'delete']);
        const deletes = s3Mock.commandCalls(DeleteObjectCommand);
        expect(deletes[0].args[0].input).toMatchObject({ Bucket: BUCKET, Key: 'incoming/result.json' });
    });

    it('does not delete the original when the upload fails', async () => {
        s3Mock.on(PutObjectCommand).rejects(new Error('upload boom'));

        await expect(invoke(event('incoming/result.json'))).rejects.toThrow('upload boom');
        expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
    });

    it('decodes url-encoded keys before fetching', async () => {
        const uploads = captureUploads();

        await invoke(event('incoming/my+report%40v2.json'));

        const get = s3Mock.commandCalls(GetObjectCommand)[0].args[0].input;
        expect(get.Key).toBe('incoming/my report@v2.json');
        expect(uploads[0].key).toBe('archive/my report@v2.json.zip');
        expect(new AdmZip(uploads[0].body).getEntries()[0].entryName).toBe('my report@v2.json');
    });

    it('processes every record in a batched event', async () => {
        const uploads = captureUploads();
        const batched = event('incoming/a.json');
        batched.Records.push(event('incoming/b.json').Records[0]);

        await invoke(batched);

        expect(uploads.map((u) => u.key)).toEqual(['archive/a.json.zip', 'archive/b.json.zip']);
    });
});
