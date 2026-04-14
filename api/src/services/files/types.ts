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
  /** Source path — only set for move_file so the frontend can render "from → to". */
  from?: string;
}
