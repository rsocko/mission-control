# Connector Data and Privacy

Connectors move data between Mission Control and services selected by the
operator. Operators are responsible for confirming they have authority to
process that data and for complying with the upstream service's terms.

## Data boundaries

- Credentials are configuration, not repository content. Never commit them.
- Connector records are stored in the configured Mission Control database.
- A connector should request only permissions needed for enabled capabilities.
- Logs must omit tokens, message bodies, personal data, and raw upstream
  payloads unless a documented, opt-in diagnostic mode safely redacts them.
- Fixtures, examples, screenshots, and tests must use synthetic identities and
  content.

## Read, write, and deletion behavior

Each connector must document whether it reads, creates, updates, completes, or
deletes upstream data. A local deletion must not imply upstream deletion unless
the connector explicitly supports and confirms that operation.

Disabling a connector stops future synchronization but does not automatically
delete previously synchronized local records. Before removing local data,
operators should back up the database, verify the connector is disabled, and
follow the connector-specific deletion procedure.

## Adding or changing a connector

A pull request must document:

- data categories and identifiers collected;
- upstream permissions and authentication method;
- local storage, retention, and deletion behavior;
- write-back and conflict ownership;
- webhook, polling, and retry behavior;
- user-visible failure handling; and
- any transfer to an AI or other subprocess.

Use placeholders such as `user@example.test`, `https://api.example.test`, and
`example-owner/example-repository`. Never use copied production payloads.
