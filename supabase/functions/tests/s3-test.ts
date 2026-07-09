import { assert, assertEquals } from "@std/assert";
import { GetObjectCommand, S3Client } from "npm:@aws-sdk/client-s3@3";
import {
  allowPublicRead,
  copyBook,
  deleteFilesByPrefix,
  getBucketName,
  getS3PrefixFromEncodedPath,
  getS3UrlFromPrefix,
  getTemporaryS3Credentials,
  kS3Region,
  listPrefixContentsKeys,
  uploadTestFileToS3,
} from "../_shared/s3.ts";
import { Environment } from "../_shared/utils.ts";
import { testRequiringSecrets } from "./testSecrets.ts";

Deno.test("s3 - getS3PrefixFromEncodedPath decodes the url-encoded prefix", () => {
  assertEquals(
    getS3PrefixFromEncodedPath(
      "https://s3.amazonaws.com/BloomLibraryBooks/foo%2fbar+baz/boo/",
      Environment.PRODUCTION
    ),
    "foo/bar baz/boo/"
  );
});

Deno.test("s3 - getS3PrefixFromEncodedPath rejects a path from another bucket", () => {
  let threw = false;
  try {
    getS3PrefixFromEncodedPath(
      "https://s3.amazonaws.com/BloomLibraryBooks-Sandbox/foo/",
      Environment.PRODUCTION
    );
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("s3 - getS3UrlFromPrefix", () => {
  assertEquals(
    getS3UrlFromPrefix("testBookId/12345678/", Environment.PRODUCTION),
    "https://s3.amazonaws.com/BloomLibraryBooks/testBookId/12345678/"
  );
});

// --- Live tests against the BloomLibraryBooks-UnitTests bucket (ported from ---
// --- the Azure s3.test.ts). Skipped unless the unit-test S3 credentials    ---
// --- are present.                                                          ---

const kS3UnitTestSecrets = [
  "BLOOM_UPLOAD_PERMISSION_MANAGER_S3_ACCESS_KEY_ID_UNIT_TEST",
  "BLOOM_UPLOAD_PERMISSION_MANAGER_S3_SECRET_ACCESS_KEY_UNIT_TEST",
];

const pathNamesForMainTests = [
  "12345678",
  "蔬.htm",
  "foo/bar",
  "1 + 2.txt",
  "&=%,@$'.png",
];

async function deleteAllTestFiles() {
  await deleteFilesByPrefix("testBookId", Environment.UNITTEST);
  await deleteFilesByPrefix("test2BookId", Environment.UNITTEST);
  await deleteFilesByPrefix("test3BookId", Environment.UNITTEST);
}

testRequiringSecrets({
  name: "s3 - live: list, copy, delete, temporary credentials, public read",
  secrets: kS3UnitTestSecrets,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const env = Environment.UNITTEST;
    try {
      // setup
      await deleteAllTestFiles();
      for (const pathName of pathNamesForMainTests) {
        await uploadTestFileToS3(`testBookId/${pathName}`, env);
      }
      await uploadTestFileToS3("test3BookId/toBeDeleted", env);
      await uploadTestFileToS3("test3BookId/toBeDeleted/subdirectory", env);
      await uploadTestFileToS3("test3BookId/toNotGetDeleted/subdirectory2", env);

      // listPrefixContentsKeys sees everything we uploaded, including the
      // tricky path names (unicode, +, &=%,@$')
      const testBookKeys = await listPrefixContentsKeys("testBookId", env);
      assertEquals(testBookKeys.length, pathNamesForMainTests.length);
      for (const pathName of pathNamesForMainTests) {
        assert(testBookKeys.includes(`testBookId/${pathName}`));
      }

      // copyBook copies each file to the destination prefix
      await copyBook("testBookId/", "test2BookId/", pathNamesForMainTests, env);
      const copiedKeys = await listPrefixContentsKeys("test2BookId", env);
      assertEquals(copiedKeys.length, pathNamesForMainTests.length);
      for (const pathName of pathNamesForMainTests) {
        assert(copiedKeys.includes(`test2BookId/${pathName}`));
      }

      // deleteFilesByPrefix deletes only under the given prefix
      await deleteFilesByPrefix("test3BookId/toBeDeleted", env);
      assertEquals(
        (await listPrefixContentsKeys("test3BookId/toBeDeleted", env)).length,
        0
      );
      assert((await listPrefixContentsKeys("test3BookId", env)).length > 0);

      // deleteFilesByPrefix with an excluded prefix keeps the exclusion
      await uploadTestFileToS3("test3BookId/toBeDeleted", env);
      await deleteFilesByPrefix(
        "test3BookId/",
        env,
        "test3BookId/toNotGetDeleted/"
      );
      assertEquals(
        (await listPrefixContentsKeys("test3BookId/toBeDeleted", env)).length,
        0
      );
      assert(
        (await listPrefixContentsKeys("test3BookId/toNotGetDeleted", env))
          .length > 0
      );

      // getTemporaryS3Credentials returns credentials scoped to the prefix
      const testPrefix = "supabaseFunctionUnitTests";
      const creds = await getTemporaryS3Credentials(testPrefix, env);
      assert(creds?.AccessKeyId && creds.SecretAccessKey && creds.SessionToken);
      const tempCredentialsClient = new S3Client({
        region: kS3Region,
        credentials: {
          accessKeyId: creds!.AccessKeyId!,
          secretAccessKey: creds!.SecretAccessKey!,
          sessionToken: creds!.SessionToken,
        },
      });

      // can upload within the prefix...
      const uploadResponse = await uploadTestFileToS3(
        testPrefix + "/testfile",
        env,
        tempCredentialsClient
      );
      assertEquals(uploadResponse.$metadata.httpStatusCode, 200);

      // ...but not outside it
      let denied = false;
      try {
        await uploadTestFileToS3(
          "testBookId/shouldFailUploadFile",
          env,
          tempCredentialsClient
        );
      } catch (e) {
        denied = (e as { Code?: string }).Code === "AccessDenied";
      }
      assert(denied, "upload outside the temp-credential prefix should fail");

      // allowPublicRead makes a previously unreadable object readable
      const downloadCommand = () =>
        new GetObjectCommand({
          Bucket: getBucketName(env),
          Key: "testBookId/12345678",
        });
      denied = false;
      try {
        const r = await tempCredentialsClient.send(downloadCommand());
        await r.Body?.transformToString();
      } catch (e) {
        denied = (e as { Code?: string }).Code === "AccessDenied";
      }
      assert(denied, "download before allowPublicRead should fail");

      await allowPublicRead("testBookId/12345678", env);
      const downloadResponse = await tempCredentialsClient.send(
        downloadCommand()
      );
      await downloadResponse.Body?.transformToString();
      assertEquals(downloadResponse.$metadata.httpStatusCode, 200);
    } finally {
      await deleteAllTestFiles();
      await deleteFilesByPrefix("supabaseFunctionUnitTests", Environment.UNITTEST);
    }
  },
});
