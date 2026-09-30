// Common Deno.serve wrapper for every Cloud TC edge function: CORS preflight,
// method + JSON-body handling, and turning a thrown HttpError into the right JSON
// response. Keeps each function's index.ts focused on its own request shape.
import { CORS_HEADERS, errorResponse, HttpError } from "./errors.ts";

export type JsonHandler = (
    req: Request,
    body: Record<string, unknown>,
) => Promise<Response>;

/** Fails fast (throws HttpError 400) if `value` is missing/empty — used for the
 * required fields in each function's request body. */
export const requireField = <T>(
    body: Record<string, unknown>,
    name: string,
): T => {
    const value = body[name];
    if (value === undefined || value === null || value === "") {
        throw new HttpError(400, { error: "invalid_request", field: name });
    }
    return value as T;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A required id field, which must be a UUID; returned lowercase, the form the database
 * stores and prints. S3 keys are built from ids (tc/{collectionId}/books/{instanceId}/...)
 * and compared byte for byte, while Postgres accepts other spellings of a UUID (upper case,
 * braces), so an id is canonicalized before any key or credential scope is made from it. */
export const requireUuidField = (
    body: Record<string, unknown>,
    name: string,
): string => {
    const value = requireField<unknown>(body, name);
    if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
        throw new HttpError(400, { error: "invalid_request", field: name });
    }
    return value.toLowerCase();
};

export const optionalField = <T>(
    body: Record<string, unknown>,
    name: string,
): T | null => (body[name] as T | undefined) ?? null;

export const serveJsonPost = (handler: JsonHandler): void => {
    Deno.serve(async (req: Request) => {
        if (req.method === "OPTIONS") {
            return new Response(null, { headers: CORS_HEADERS });
        }
        if (req.method !== "POST") {
            return errorResponse(405, "method_not_allowed");
        }

        let body: Record<string, unknown>;
        try {
            const text = await req.text();
            body = text ? JSON.parse(text) : {};
        } catch {
            return errorResponse(400, "invalid_json");
        }

        try {
            return await handler(req, body);
        } catch (err) {
            if (err instanceof HttpError) {
                return err.toResponse();
            }
            console.error("Unhandled error:", err);
            return errorResponse(500, "internal_error", {
                message: String(err),
            });
        }
    });
};
