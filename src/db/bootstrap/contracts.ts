export interface DatabaseBootstrapAdapter {
  initialize(): Promise<void>;
}
