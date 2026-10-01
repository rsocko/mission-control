# Paperclip-to-Scout bridge

Mission Control is the policy and audit boundary between Paperclip and Scout.
Paperclip never receives Scout's pull credential or a direct Microsoft
credential. Scout receives work only through the existing external-agent
dispatch lease, claim-token, result-fencing, and event-audit lifecycle.

## Configuration

Register Scout as an enabled `pull-queue` external agent with:

- `inputFormat: "scout-capability-request-v1"`;
- bearer authentication backed by a server-side
  `MC_EXTERNAL_AGENT_CREDENTIALS_JSON` reference;
- `dataPolicy.fieldAllowlist` containing `brokerRequest` and the standard
  external-agent control fields;
- `capabilities.allowedActions` containing each exact `tool:action` pair that
  Scout accepts.

Add a `scoutBridge` policy to the existing Paperclip provider config:

```json
{
  "destinationAgentId": "scout-pull",
  "tenantId": "synthetic-tenant",
  "capabilities": [
    {
      "tool": "m365.search",
      "actions": ["search"],
      "inputFields": ["query", "limit"],
      "risk": "low"
    }
  ]
}
```

The configured Paperclip company and assignee are the only requester identity.
Each capability independently fixes its tool, actions, disclosed input fields,
and risk. Unknown input fields are rejected rather than silently forwarded.
Restricted and local-only classifications are denied by the bridge.

Automation is off when `automation` is absent or disabled. A deployment may
explicitly enable narrowly listed low-risk `tool` and `action` pairs. Messaging,
destructive, identity, financial, declared-high-risk, and action names with
high-risk semantics remain human-confirmed even if they appear in that list.

The inbound bridge credential is separate from both the Paperclip provider
credential and Scout credential. Store it under the server-side reference
`paperclip-scout:<paperclip external-agent id>`. Do not expose any of these
credential values in provider config, dispatch payloads, logs, or receipts.

## Request contract

Paperclip sends `POST /api/external-agents/paperclip/scout` with:

```json
{
  "paperclipAgentId": "paperclip-provider",
  "requestId": "paperclip-request-123",
  "companyId": "11111111-1111-4111-8111-111111111111",
  "agentId": "22222222-2222-4222-8222-222222222222",
  "destinationAgentId": "scout-pull",
  "tenantId": "synthetic-tenant",
  "tool": "m365.search",
  "action": "search",
  "dataClassification": "standard",
  "input": {
    "query": "synthetic project status",
    "limit": 10
  }
}
```

Authenticate the exact raw request with:

- `X-MC-Paperclip-Agent-Id`: the configured Paperclip external-agent ID;
- `X-MC-Paperclip-Timestamp`: an RFC 3339 timestamp within five minutes;
- `X-MC-Paperclip-Signature`: `sha256=<hex HMAC-SHA256>`.

The HMAC input is five newline-separated values:

```text
<timestamp>
<Paperclip external-agent ID>
<uppercase HTTP method>
<URL pathname>
<hex SHA-256 of the exact raw body>
```

The destination and tenant in the request must exactly match policy. The
idempotency key is derived from the Paperclip provider identity and
`requestId`. Repeating the same request returns the existing dispatch; changing
the destination or minimized payload under the same key returns a conflict.
Expired signatures are rejected.

The response reports only `queued`, `waiting-for-user`, `rejected`, `failed`,
`timed-out`, `cancelled`, or `completed`. A default request is
`waiting-for-user` and includes the destination-bound preview hash,
classification, disclosed fields, and exact allowed action. A trusted MC user
confirms that hash through the existing external-agent dispatch confirmation
route.

Paperclip can poll
`GET /api/external-agents/paperclip/scout/<dispatch id>`
using the same signature scheme with an empty body. It can observe status and
the bounded result but cannot confirm, claim, cancel, or complete work.

## Scout claim and result contract

Scout claims accepted work through
`POST /api/external-agents/dispatches/claim` using its own external-agent
credential. Before returning a claim, MC revalidates:

- the destination external-agent identity;
- the configured Paperclip company and agent;
- the tenant;
- the exact tool and action in both source policy and Scout capability policy;
- the risk classification.

A failed revalidation terminally fails the dispatch instead of returning
success-shaped work. Lease expiry and reclaim, deadline expiry, rate limits,
and claim-token hashing use the existing external-agent control-plane
implementation.

Scout posts lifecycle or terminal results to the existing dispatch result
route with the claim token. A completed result must include a stable
`providerDetail.sourceReceiptId` from the authoritative source operation.
Mission Control persists the Paperclip request ID in the minimized broker
request, the MC dispatch ID, claim attempt, Scout provider task/detail, source
receipt ID, result digest, and dispatch events. Exact duplicate completion is
idempotent; a different completion after terminal state is rejected.

No Paperclip, Scout, or Microsoft token is persisted in the preview, result, or
audit event. Existing retention cleanup applies to the dispatch and its
correlated attempts and events.
