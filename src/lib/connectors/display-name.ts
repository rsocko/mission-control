interface ConnectorIdentity {
  name: string;
  type: string;
}

export function getConnectorDisplayName(connector: ConnectorIdentity) {
  if (
    connector.type === 'document-intelligence'
    && (connector.name === 'Document Intelligence' || connector.name === 'Doc Intelligence')
  ) {
    return 'OWL';
  }
  return connector.name;
}

export function getConnectorNameUpdate(
  connector: ConnectorIdentity,
  editedName: string,
  nameChanged: boolean,
) {
  return nameChanged ? editedName : connector.name;
}
