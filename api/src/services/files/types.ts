export interface FileEntry {
  path: string;
  isDirectory: boolean;
}

export interface FileContent {
  path: string;
  content: string;
}

export interface AgentAction {
  tool: string;
  path?: string;
  summary: string;
}
