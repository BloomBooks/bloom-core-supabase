// Unit tests for checkin-start's handler: PostgREST RPC calls are faked via a fetch
// stub (see _shared/tc/test_support.ts); the MinIO/STS AssumeRole call is faked via
// aws-sdk-client-mock. These pin down the handler's own request validation, RPC-argument
// wiring, credential scoping and error passthrough cheaply and hermetically.
import { assertEquals, assertRejects } from "@std/assert";
import { AssumeRoleCommand } from "@aws-sdk/client-sts";
import {
    callHandler,
    mockRequest,
    type RecordedCall,
    routedFetchStub,
    setTestEnv,
    stubAssumeRole,
    withMockFetch,
} from "../_shared/tc/test_support.ts";

setTestEnv();
const { handler } = await import("../checkin-start/index.ts");

const VALID_BODY = {
    collectionId: "11111111-1111-1111-1111-111111111111",
    instanceId: "22222222-2222-2222-2222-222222222222",
    proposedName: "My Book",
    checksum: "abc123",
    clientVersion: "1.0.0",
    files: [{ path: "index.htm", sha256: "deadbeef", size: 42 }],
};

Deno.test(
    "checkin-start: happy path returns transactionId, changedPaths and creds scoped to the book's instance id",
    async () => {
        const stsMock = stubAssumeRole();
        const calls: RecordedCall[] = [];
        const fetchStub = routedFetchStub([
            {
                when: "rpc/checkin_start_tx",
                status: 200,
                body: {
                    transactionId: "tx-1",
                    changedPaths: ["index.htm"],
                },
            },
        ], calls);

        const res = await withMockFetch(fetchStub, () =>
            callHandler(handler, mockRequest(VALID_BODY), VALID_BODY),
        );

        assertEquals(res.status, 200);
        const json = await res.json();
        assertEquals(json.transactionId, "tx-1");
        assertEquals(json.changedPaths, ["index.htm"]);
        assertEquals(json.s3.bucket, "bloom-teams-test");
        // CONTRACTS.md: creds scoped to tc/{cid}/books/{instanceId}/*. The RPC checks or
        // creates exactly the book named by (collectionId, instanceId), so no other read
        // is needed.
        assertEquals(
            calls.map((c) => new URL(c.url).pathname),
            ["/rest/v1/rpc/checkin_start_tx"],
        );
        assertEquals(
            json.s3.prefix,
            "tc/11111111-1111-1111-1111-111111111111/books/22222222-2222-2222-2222-222222222222/",
        );
        assertEquals(json.s3.credentials.sessionToken, "T");
        // Check-in never issues a checkout GUID.
        assertEquals("checkoutGuid" in json, false);

        stsMock.restore();
    },
);

Deno.test(
    "checkin-start: passes the book, name, base version, manifest and GUID to checkin_start_tx",
    async () => {
        const stsMock = stubAssumeRole();
        const calls: RecordedCall[] = [];
        const fetchStub = routedFetchStub(
            [
                {
                    when: "rpc/checkin_start_tx",
                    status: 200,
                    // A stray field in the RPC's answer must not be passed on: the response
                    // carries only the contract's fields.
                    body: {
                        transactionId: "tx-1",
                        changedPaths: ["index.htm"],
                        checkoutGuid: "0b7c5d4e-1f2a-4b3c-8d9e-0a1b2c3d4e5f",
                    },
                },
            ],
            calls,
        );
        const body = {
            ...VALID_BODY,
            baseVersion: 7,
            checkoutGuid: "3f2c9a1e-5b6d-4c7e-8f90-a1b2c3d4e5f6",
        };

        const res = await withMockFetch(fetchStub, () =>
            callHandler(handler, mockRequest(body), body),
        );

        assertEquals(res.status, 200);
        const rpcCall = calls.find((c) => c.url.includes("rpc/checkin_start_tx"));
        if (!rpcCall) {
            throw new Error("checkin_start_tx was never called");
        }
        assertEquals(rpcCall.body, {
            p_collection_id: VALID_BODY.collectionId,
            p_instance_id: VALID_BODY.instanceId,
            p_proposed_name: "My Book",
            p_base_version: 7,
            p_checksum: "abc123",
            p_client_version: "1.0.0",
            p_files: VALID_BODY.files,
            p_checkout_guid: "3f2c9a1e-5b6d-4c7e-8f90-a1b2c3d4e5f6",
        });
        const json = await res.json();
        assertEquals(json.transactionId, "tx-1", "sanity check: a real 200 body");
        assertEquals(Object.keys(json).sort(), ["changedPaths", "s3", "transactionId"]);

        stsMock.restore();
    },
);

Deno.test(
    "checkin-start: no checkoutGuid or baseVersion in the body -> both null",
    async () => {
        const stsMock = stubAssumeRole();
        const calls: RecordedCall[] = [];
        const fetchStub = routedFetchStub(
            [
                {
                    when: "rpc/checkin_start_tx",
                    status: 200,
                    body: { transactionId: "tx-1", changedPaths: [] },
                },
            ],
            calls,
        );
        assertEquals("checkoutGuid" in VALID_BODY, false, "test data sanity check");
        assertEquals("baseVersion" in VALID_BODY, false, "test data sanity check");

        const res = await withMockFetch(fetchStub, () =>
            callHandler(handler, mockRequest(VALID_BODY), VALID_BODY),
        );

        assertEquals(res.status, 200);
        const rpcCall = calls.find((c) => c.url.includes("rpc/checkin_start_tx"));
        if (!rpcCall) {
            throw new Error("checkin_start_tx was never called");
        }
        assertEquals(rpcCall.body?.p_checkout_guid, null);
        assertEquals(rpcCall.body?.p_base_version, null);

        stsMock.restore();
    },
);

Deno.test(
    "checkin-start: ids are lowercased before the prefix and the RPC use them; a non-UUID id is 400",
    async () => {
        const stsMock = stubAssumeRole();
        const calls: RecordedCall[] = [];
        const fetchStub = routedFetchStub(
            [
                {
                    when: "rpc/checkin_start_tx",
                    status: 200,
                    body: { transactionId: "tx-1", changedPaths: [] },
                },
            ],
            calls,
        );
        const upper = {
            ...VALID_BODY,
            collectionId: "ABCDEF00-1111-4111-8111-111111111111",
            instanceId: "ABCDEF00-2222-4222-8222-222222222222",
        };
        assertEquals(upper.instanceId.toLowerCase() !== upper.instanceId, true, "test data sanity check");

        const res = await withMockFetch(fetchStub, () =>
            callHandler(handler, mockRequest(upper), upper),
        );

        assertEquals(res.status, 200);
        assertEquals(
            (await res.json()).s3.prefix,
            "tc/abcdef00-1111-4111-8111-111111111111/books/abcdef00-2222-4222-8222-222222222222/",
            "the key prefix must match the database's (lowercase) spelling, which finish uses",
        );
        assertEquals(calls[0]?.body?.p_instance_id, "abcdef00-2222-4222-8222-222222222222");

        for (const bad of ["{22222222-2222-2222-2222-222222222222}", "not-a-uuid"]) {
            const body = { ...VALID_BODY, instanceId: bad };
            const badRes = await withMockFetch(routedFetchStub([]), () =>
                callHandler(handler, mockRequest(body), body),
            );
            assertEquals(badRes.status, 400, `instanceId ${bad}`);
            assertEquals((await badRes.json()).field, "instanceId");
        }

        stsMock.restore();
    },
);

Deno.test(
    "checkin-start: missing required field -> 400 before any RPC/S3 call",
    async () => {
        const stsMock = stubAssumeRole();
        const fetchStub = routedFetchStub([]); // must not be called

        for (const field of ["instanceId", "checksum"] as const) {
            const { [field]: _omit, ...bodyMissingField } = VALID_BODY;
            const res = await withMockFetch(fetchStub, () =>
                callHandler(
                    handler,
                    mockRequest(bodyMissingField),
                    bodyMissingField,
                ),
            );

            assertEquals(res.status, 400);
            const json = await res.json();
            assertEquals(json.error, "invalid_request");
            assertEquals(json.field, field);
        }
        assertEquals(
            stsMock.commandCalls(AssumeRoleCommand).length,
            0,
            "must fail validation before touching S3",
        );

        stsMock.restore();
    },
);

Deno.test(
    "checkin-start: RPC 409 LockHeldByOther passes through with the holder payload intact",
    async () => {
        const stsMock = stubAssumeRole();
        const fetchStub = routedFetchStub([
            {
                when: "rpc/checkin_start_tx",
                status: 409,
                // PostgREST wraps our RAISE EXCEPTION message like this — see rpc.ts's
                // parsePostgrestErrorBody, which unwraps it back to the flat contract shape.
                body: {
                    message: JSON.stringify({
                        error: "LockHeldByOther",
                        holder: { userId: "u2", name: "User Two" },
                    }),
                },
            },
        ]);

        const res = await withMockFetch(fetchStub, () =>
            callHandler(handler, mockRequest(VALID_BODY), VALID_BODY),
        );

        assertEquals(res.status, 409);
        const json = await res.json();
        assertEquals(json.error, "LockHeldByOther");
        assertEquals(json.holder, { userId: "u2", name: "User Two" });
        // Credentials are obtained before the RPC (see the ordering tests below), but a
        // refused start must never hand them out.
        assertEquals("s3" in json, false, "must not return S3 creds when the RPC failed");

        stsMock.restore();
    },
);

Deno.test(
    "checkin-start: RPC 409 CheckoutElsewhere and 404 book_not_found pass through as flat error envelopes, with no S3 creds",
    async () => {
        const stsMock = stubAssumeRole();
        for (const [status, error] of [[409, "CheckoutElsewhere"], [404, "book_not_found"]] as const) {
            const fetchStub = routedFetchStub([
                {
                    when: "rpc/checkin_start_tx",
                    status,
                    body: { message: JSON.stringify({ error }) },
                },
            ]);

            const res = await withMockFetch(fetchStub, () =>
                callHandler(handler, mockRequest(VALID_BODY), VALID_BODY),
            );

            assertEquals(res.status, status);
            // Exactly the error envelope: no S3 creds are handed out.
            assertEquals(await res.json(), { error });
        }

        stsMock.restore();
    },
);

Deno.test("checkin-start: RPC 426 ClientOutOfDate passes through", async () => {
    const stsMock = stubAssumeRole();
    const fetchStub = routedFetchStub([
        {
            when: "rpc/checkin_start_tx",
            status: 426,
            body: {
                message: JSON.stringify({
                    error: "ClientOutOfDate",
                    minVersion: "2.0.0",
                }),
            },
        },
    ]);

    const res = await withMockFetch(fetchStub, () =>
        callHandler(handler, mockRequest(VALID_BODY), VALID_BODY),
    );

    assertEquals(res.status, 426);
    const json = await res.json();
    assertEquals(json.error, "ClientOutOfDate");
    assertEquals(json.minVersion, "2.0.0");

    stsMock.restore();
});

Deno.test(
    "checkin-start: missing Authorization header -> 401 (defensive; platform normally rejects first)",
    async () => {
        const stsMock = stubAssumeRole();

        const reqNoAuth = new Request("http://localhost/test", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(VALID_BODY),
        });
        const res = await callHandler(handler, reqNoAuth, VALID_BODY);

        assertEquals(res.status, 401);
        stsMock.restore();
    },
);

// Everything that can fail (STS) must happen before checkin_start_tx commits an attempt the
// client might never hear of; see the handler.
Deno.test(
    "checkin-start: an STS failure happens before checkin_start_tx, so nothing is committed",
    async () => {
        const stsMock = stubAssumeRole();
        stsMock.on(AssumeRoleCommand).rejects(new Error("simulated STS outage"));
        const calls: RecordedCall[] = [];
        const fetchStub = routedFetchStub(
            [
                {
                    when: "rpc/checkin_start_tx",
                    status: 200,
                    body: { transactionId: "tx-1", changedPaths: [] },
                },
            ],
            calls,
        );

        await assertRejects(
            () =>
                withMockFetch(fetchStub, () =>
                    callHandler(handler, mockRequest(VALID_BODY), VALID_BODY),
                ),
            Error,
            "simulated STS outage",
        );
        assertEquals(
            stsMock.commandCalls(AssumeRoleCommand).length,
            1,
            "sanity check: STS was really asked (and failed)",
        );
        assertEquals(
            calls.some((c) => c.url.includes("rpc/checkin_start_tx")),
            false,
            "checkin_start_tx must not run once STS has failed",
        );

        stsMock.restore();
    },
);

Deno.test(
    "checkin-start: credentials are issued before checkin_start_tx",
    async () => {
        const stsMock = stubAssumeRole();
        const calls: RecordedCall[] = [];
        const rpcCallsAtEachStsCall: number[] = [];
        stsMock.on(AssumeRoleCommand).callsFake(() => {
            rpcCallsAtEachStsCall.push(
                calls.filter((c) => c.url.includes("rpc/checkin_start_tx")).length,
            );
            return {
                Credentials: {
                    AccessKeyId: "K",
                    SecretAccessKey: "S",
                    SessionToken: "T",
                    Expiration: new Date("2026-01-01T01:00:00Z"),
                },
            };
        });
        const fetchStub = routedFetchStub(
            [
                {
                    when: "rpc/checkin_start_tx",
                    status: 200,
                    body: { transactionId: "tx-1", changedPaths: ["index.htm"] },
                },
            ],
            calls,
        );

        const res = await withMockFetch(fetchStub, () =>
            callHandler(handler, mockRequest(VALID_BODY), VALID_BODY),
        );

        assertEquals(res.status, 200);
        assertEquals(rpcCallsAtEachStsCall, [0], "STS must be called once, before the RPC");
        assertEquals((await res.json()).changedPaths, ["index.htm"]);

        stsMock.restore();
    },
);
