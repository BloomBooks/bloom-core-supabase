import { handleSubscriptionInfoRequest } from "./subscriptions.ts";

// Looks up a Bloom subscription code in the subscriptions Google Sheet.
// Example use: https://api.bloomlibrary.org/v1/subscriptionInfo/SIL-LEAD-123456-1234
Deno.serve(handleSubscriptionInfoRequest);
