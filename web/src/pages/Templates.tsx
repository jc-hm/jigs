import {
  useState,
  useEffect,
  useCallback,
  useRef,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type DragEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  fileLs,
  fileCat,
  fileWrite,
  fileRm,
  fileRmDir,
  fileMv,
  fileMkdir,
  streamAgent,
} from "../lib/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// `inProgress` is true while we're still consuming the SSE stream for this
// message — used to render the spinner inline instead of as a separate row.
// `retryCount`/`retryMax` come from `retry` SSE events: when the Bedrock
// wrapper hits a retryable error and is about to back off, the route relays
// a `retry` event so we can surface "AI is busy — retry 3/5" in the chat,
// rather than leaving the user staring at a generic spinner during the wait.
interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  inProgress?: boolean;
  retryCount?: number;
  retryMax?: number;
}

interface TreeNode {
  path: string;
  name: string;
  isDirectory: boolean;
  children?: TreeNode[];
  expanded?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_PANEL = 180;

// ---------------------------------------------------------------------------
// Tree helpers (module-level, no hooks)
// ---------------------------------------------------------------------------

// Returns the set of all currently-expanded directory paths so refreshTree
// can restore the same open/closed state after reloading from the server.
function getExpandedPaths(nodes: TreeNode[]): Set<string> {
  const result = new Set<string>();
  for (const node of nodes) {
    if (node.isDirectory && node.expanded) {
      result.add(node.path);
      if (node.children) {
        for (const p of getExpandedPaths(node.children)) result.add(p);
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface TemplatesProps {
  // Optional sub-path parsed from `#templates/<path>` by App.tsx. When
  // present, the page auto-selects that file on mount (and when the hash
  // changes while Templates is already visible — e.g. from the matched-
  // template link on the Fill page). When the user picks a different
  // file manually, we write the selection back into the hash so reload
  // lands on the same place.
  initialPath?: string;
}

export function Templates({ initialPath }: TemplatesProps) {
  const { t } = useTranslation();
  // --- File tree ---
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // Tracks the initial `loadDir("")` so the tree pane can render a
  // skeleton instead of "No files yet" while the first list is in flight.
  // Expand/collapse calls on subdirectories don't flip this — they're
  // short enough that their own inline indicator isn't worth the weight.
  const [isLoadingTree, setIsLoadingTree] = useState(true);

  // --- Editor ---
  const [editorContent, setEditorContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  // True while `selectFile` is awaiting `fileCat`. Without this the
  // editor shows stale content (or "Select a file to edit" on the very
  // first click) until the cat call returns, so the user gets no feedback
  // that their click was registered.
  const [isLoadingFile, setIsLoadingFile] = useState(false);

  // --- Inline input (new file / folder inside a directory) ---
  const [inlineInput, setInlineInput] = useState<{
    parentPath: string;
    type: "file" | "folder";
  } | null>(null);
  const [inlineValue, setInlineValue] = useState("");

  // --- Rename ---
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // --- Context menu ---
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    node: TreeNode;
  } | null>(null);

  // --- Drag and drop ---
  const [dragSource, setDragSource] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // --- Tree refs ---
  // treeRef always mirrors the latest `tree` state so callbacks that should
  // NOT have `tree` in their deps (e.g. refreshTree, expandAncestors) can
  // still read the current tree without causing stale-closure bugs.
  const treeRef = useRef<TreeNode[]>([]);
  const treeScrollAreaRef = useRef<HTMLDivElement>(null);
  // When the tree hasn't finished loading yet but we already know which file
  // to reveal (e.g. from initialPath on mount), we park the path here and
  // expand its ancestors once isLoadingTree flips to false.
  const [pendingExpandPath, setPendingExpandPath] = useState<string | null>(
    initialPath ?? null
  );

  // --- Agent chat ---
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  // --- Resizable panels ---
  const [leftWidth, setLeftWidth] = useState(280);
  const [rightWidth, setRightWidth] = useState(224);
  const containerRef = useRef<HTMLDivElement>(null);
  const resizingRef = useRef<"left" | "right" | null>(null);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const isDirty = editorContent !== savedContent;

  // Keep treeRef in sync so callbacks that can't take `tree` as a dep
  // (refreshTree, expandAncestors) always see the latest value.
  useEffect(() => {
    treeRef.current = tree;
  }, [tree]);

  // -------------------------------------------------------------------------
  // Tree loading
  // -------------------------------------------------------------------------

  const loadDir = useCallback(
    async (dirPath: string): Promise<TreeNode[]> => {
      const entries = await fileLs(dirPath || "/");
      return entries.map((e) => ({
        path: dirPath ? `${dirPath}/${e.path}` : e.path,
        name: e.path,
        isDirectory: e.isDirectory,
        children: undefined,
        expanded: false,
      }));
    },
    []
  );

  // Reload the root listing from the server while restoring any folders the
  // user had open. Uses treeRef (not `tree` state) so this callback stays
  // stable — adding `tree` to its deps would cause the initial useEffect
  // below to re-fire on every tree change.
  const refreshTree = useCallback(async () => {
    try {
      const expandedPaths = getExpandedPaths(treeRef.current);
      const rootNodes = await loadDir("");

      if (expandedPaths.size === 0) {
        setTree(rootNodes);
        return;
      }

      // Re-expand any directory that was open before the refresh.
      const restoreExpanded = async (nodes: TreeNode[]): Promise<TreeNode[]> => {
        const result: TreeNode[] = [];
        for (const node of nodes) {
          if (node.isDirectory && expandedPaths.has(node.path)) {
            const children = await loadDir(node.path);
            result.push({
              ...node,
              expanded: true,
              children: await restoreExpanded(children),
            });
          } else {
            result.push(node);
          }
        }
        return result;
      };

      setTree(await restoreExpanded(rootNodes));
    } finally {
      setIsLoadingTree(false);
    }
  }, [loadDir]);

  useEffect(() => {
    refreshTree();
  }, [refreshTree]);

  // Close context menu on outside click
  useEffect(() => {
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  // Auto-scroll the agent chat to the bottom as new tool events, text, or
  // retry updates land. Guarded by a "near-bottom" check so users who have
  // scrolled up to re-read an earlier tool call aren't yanked back down on
  // every streamed update. The existing finally-block scroll at the end of
  // handleSend still fires as a final "land on the bottom" nudge.
  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  // -------------------------------------------------------------------------
  // File selection (with dirty guard)
  // -------------------------------------------------------------------------

  const guardDirty = useCallback((): boolean => {
    if (!isDirty) return true;
    return window.confirm(t("tmpl.discardConfirm"));
  }, [isDirty, t]);

  const selectFile = useCallback(
    async (path: string) => {
      if (path === selectedPath) return;
      if (!guardDirty()) return;
      // Mark the path as selected immediately so the editor header
      // switches over and the spinner has something to render against,
      // even though the content is still loading.
      setSelectedPath(path);
      setEditorContent("");
      setSavedContent("");
      setIsLoadingFile(true);
      try {
        const { content } = await fileCat(path);
        setEditorContent(content);
        setSavedContent(content);
      } catch {
        setError(t("tmpl.errorOpen", { path }));
      } finally {
        setIsLoadingFile(false);
      }
    },
    [selectedPath, guardDirty]
  );

  // -------------------------------------------------------------------------
  // Ancestor expansion + scroll-to-file
  // -------------------------------------------------------------------------

  // Expands every ancestor directory of `filePath` that is already in the
  // tree (fetching children for any that weren't open yet) so the file row
  // becomes visible. Works off treeRef so it doesn't need `tree` in deps.
  const expandAncestors = useCallback(
    async (filePath: string) => {
      const parts = filePath.split("/");
      if (parts.length <= 1) return; // root-level file — already visible

      const ancestorSet = new Set<string>();
      for (let i = 1; i < parts.length; i++) {
        ancestorSet.add(parts.slice(0, i).join("/"));
      }

      const expandNodes = async (nodes: TreeNode[]): Promise<TreeNode[]> => {
        const result: TreeNode[] = [];
        for (const node of nodes) {
          if (node.isDirectory && ancestorSet.has(node.path)) {
            if (!node.expanded || !node.children) {
              const children = await loadDir(node.path);
              result.push({
                ...node,
                expanded: true,
                children: await expandNodes(children),
              });
            } else {
              result.push({ ...node, children: await expandNodes(node.children) });
            }
          } else if (node.isDirectory && node.expanded && node.children) {
            result.push({ ...node, children: await expandNodes(node.children) });
          } else {
            result.push(node);
          }
        }
        return result;
      };

      setTree(await expandNodes(treeRef.current));
    },
    [loadDir]
  );

  // Scrolls the file-tree row for `path` into view (called after state
  // updates settle via a brief timeout so the DOM reflects the new tree).
  const scrollToTreePath = useCallback((path: string) => {
    setTimeout(() => {
      treeScrollAreaRef.current
        ?.querySelector(`[data-tree-path="${CSS.escape(path)}"]`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, 50);
  }, []);

  // --- Hash ↔ selection sync ---
  //
  // Three effects:
  //   1. Hash → file content: when `initialPath` arrives (on mount, or when
  //      the user follows the matched-template link from Fill), load the file
  //      and update pendingExpandPath so the tree expands once ready.
  //   2. Tree ready → expand + scroll: once isLoadingTree flips false and
  //      pendingExpandPath is set, expand ancestors and scroll to the file.
  //   3. State → hash: mirror the selected file back into the URL hash so
  //      reloads land on the same file.
  useEffect(() => {
    if (initialPath) {
      selectFile(initialPath);
      if (isLoadingTree) {
        // Tree not ready yet — park the path; effect 2 will handle it.
        setPendingExpandPath(initialPath);
      } else {
        expandAncestors(initialPath).then(() => scrollToTreePath(initialPath));
      }
    }
    // We deliberately do NOT include `selectFile` / `expandAncestors` /
    // `isLoadingTree` in the deps here — their identities change with state
    // in ways that would cause repeated re-fires and fight with user
    // interaction. `initialPath` is the only meaningful trigger here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPath]);

  // Once the tree finishes loading, apply any pending ancestor expansion.
  // This covers the initial-mount case where `initialPath` arrived before
  // the first `loadDir("")` completed.
  useEffect(() => {
    if (!isLoadingTree && pendingExpandPath) {
      const path = pendingExpandPath;
      setPendingExpandPath(null);
      expandAncestors(path).then(() => scrollToTreePath(path));
    }
    // expandAncestors / scrollToTreePath are stable; omitting them from deps
    // intentionally to avoid re-firing when they re-create.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoadingTree]);

  useEffect(() => {
    const desired = selectedPath
      ? `#templates/${selectedPath}`
      : `#templates`;
    if (window.location.hash !== desired) {
      window.history.replaceState(null, "", desired);
    }
  }, [selectedPath]);

  // -------------------------------------------------------------------------
  // Tree expand / collapse
  // -------------------------------------------------------------------------

  const toggleDir = useCallback(
    async (targetPath: string) => {
      const updateNodes = async (
        nodes: TreeNode[]
      ): Promise<TreeNode[]> => {
        const result: TreeNode[] = [];
        for (const node of nodes) {
          if (node.path === targetPath && node.isDirectory) {
            if (node.expanded) {
              result.push({ ...node, expanded: false, children: undefined });
            } else {
              const children = await loadDir(node.path);
              result.push({ ...node, expanded: true, children });
            }
          } else if (node.children) {
            result.push({
              ...node,
              children: await updateNodes(node.children),
            });
          } else {
            result.push(node);
          }
        }
        return result;
      };
      setTree(await updateNodes(tree));
    },
    [tree, loadDir]
  );

  // -------------------------------------------------------------------------
  // File operations
  // -------------------------------------------------------------------------

  const handleSave = useCallback(async () => {
    if (!selectedPath || isSaving) return;
    setIsSaving(true);
    try {
      await fileWrite(selectedPath, editorContent);
      setSavedContent(editorContent);
    } catch {
      setError(t("tmpl.errorSave"));
    } finally {
      setIsSaving(false);
    }
  }, [selectedPath, editorContent, isSaving]);

  const handleDiscard = useCallback(() => {
    setEditorContent(savedContent);
  }, [savedContent]);

  const handleDelete = useCallback(
    async (path: string, isDirectory: boolean) => {
      const confirmMsg = isDirectory
        ? t("tmpl.deleteFolderConfirm", { path })
        : t("tmpl.deleteFileConfirm", { path });
      if (!window.confirm(confirmMsg)) return;
      try {
        if (isDirectory) {
          await fileRmDir(path);
        } else {
          await fileRm(path);
        }
        if (selectedPath === path) {
          setSelectedPath(null);
          setEditorContent("");
          setSavedContent("");
        }
        await refreshTree();
      } catch {
        setError(t("tmpl.errorDelete", { path }));
      }
    },
    [selectedPath, refreshTree, t]
  );

  const handleRename = useCallback(
    async (oldPath: string, newName: string) => {
      if (!newName.trim()) {
        setRenamingPath(null);
        return;
      }
      const parts = oldPath.split("/");
      parts.pop();
      const newPath = parts.length ? `${parts.join("/")}/${newName}` : newName;
      try {
        await fileMv(oldPath, newPath);
        if (selectedPath === oldPath) setSelectedPath(newPath);
        await refreshTree();
      } catch {
        setError(t("tmpl.errorRename", { path: oldPath }));
      }
      setRenamingPath(null);
    },
    [selectedPath, refreshTree, t]
  );

  const handleInlineCreate = useCallback(
    async (type: "file" | "folder") => {
      if (!inlineInput || !inlineValue.trim()) {
        setInlineInput(null);
        setInlineValue("");
        return;
      }
      const parent = inlineInput.parentPath;
      const fullPath = parent
        ? `${parent}/${inlineValue.trim()}`
        : inlineValue.trim();
      try {
        if (type === "folder") {
          await fileMkdir(fullPath);
        } else {
          await fileWrite(fullPath, "");
        }
        await refreshTree();
        if (type === "file") await selectFile(fullPath);
      } catch {
        setError(t("tmpl.errorCreate", { path: fullPath }));
      }
      setInlineInput(null);
      setInlineValue("");
    },
    [inlineInput, inlineValue, refreshTree, selectFile, t]
  );

  // -------------------------------------------------------------------------
  // Drag and drop
  // -------------------------------------------------------------------------

  const handleDragStart = useCallback((e: DragEvent, path: string) => {
    setDragSource(path);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", path);
  }, []);

  const handleDragOver = useCallback(
    (e: DragEvent, node: TreeNode) => {
      if (!dragSource) return;
      if (!node.isDirectory) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDropTarget(node.path);
    },
    [dragSource]
  );

  const handleDragLeave = useCallback(() => {
    setDropTarget(null);
  }, []);

  const handleDrop = useCallback(
    async (e: DragEvent, targetDir: TreeNode) => {
      e.preventDefault();
      setDropTarget(null);
      if (!dragSource || !targetDir.isDirectory) return;

      const sourceName = dragSource.split("/").pop() || dragSource;
      const newPath = `${targetDir.path}/${sourceName}`;

      if (dragSource === newPath) return;

      try {
        await fileMv(dragSource, newPath);
        if (selectedPath === dragSource) setSelectedPath(newPath);
        await refreshTree();
      } catch {
        setError(t("tmpl.errorMove", { path: dragSource, dest: targetDir.path }));
      }
      setDragSource(null);
    },
    [dragSource, selectedPath, refreshTree, t]
  );

  const handleDragEnd = useCallback(() => {
    setDragSource(null);
    setDropTarget(null);
  }, []);

  // Also allow dropping on root (tree background)
  const handleRootDrop = useCallback(
    async (e: DragEvent) => {
      e.preventDefault();
      setDropTarget(null);
      if (!dragSource) return;
      const sourceName = dragSource.split("/").pop() || dragSource;
      if (dragSource === sourceName) return; // already at root
      try {
        await fileMv(dragSource, sourceName);
        if (selectedPath === dragSource) setSelectedPath(sourceName);
        await refreshTree();
      } catch {
        setError(t("tmpl.errorMoveRoot", { path: dragSource }));
      }
      setDragSource(null);
    },
    [dragSource, selectedPath, refreshTree, t]
  );

  // -------------------------------------------------------------------------
  // Resize panels
  // -------------------------------------------------------------------------

  const onResizeStart = useCallback(
    (side: "left" | "right", e: ReactMouseEvent) => {
      e.preventDefault();
      resizingRef.current = side;
      startXRef.current = e.clientX;
      startWidthRef.current = side === "left" ? leftWidth : rightWidth;

      const onMove = (ev: globalThis.MouseEvent) => {
        const delta = ev.clientX - startXRef.current;
        const containerW = containerRef.current?.offsetWidth ?? 800;
        if (resizingRef.current === "left") {
          const next = Math.max(MIN_PANEL, Math.min(startWidthRef.current + delta, containerW - MIN_PANEL * 2));
          setLeftWidth(next);
        } else {
          const next = Math.max(MIN_PANEL, Math.min(startWidthRef.current - delta, containerW - MIN_PANEL * 2));
          setRightWidth(next);
        }
      };

      const onUp = () => {
        resizingRef.current = null;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [leftWidth, rightWidth]
  );

  // -------------------------------------------------------------------------
  // Agent chat
  // -------------------------------------------------------------------------

  const handleSend = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      if (!input.trim() || isProcessing) return;

      const userMessage = input.trim();
      setInput("");
      setError(undefined);
      setIsProcessing(true);

      // Append the user's message AND a placeholder assistant row in one
      // setState — the placeholder is what we mutate as `tool`/`retry`
      // events stream in, so the user sees per-tool progress live instead
      // of waiting on the final `complete` event.
      const historyForAgent = messages;
      setMessages((prev) => [
        ...prev,
        { role: "user", text: userMessage },
        { role: "assistant", text: "", inProgress: true },
      ]);

      // Helper: update the in-progress assistant (last message) by index.
      // We compute the index off the *current* prev inside the updater so
      // we don't capture a stale length.
      const updateLast = (mut: (m: ChatMessage) => ChatMessage) => {
        setMessages((prev) => {
          const idx = prev.length - 1;
          if (idx < 0) return prev;
          const next = prev.slice();
          next[idx] = mut(next[idx]);
          return next;
        });
      };

      const toolLines: string[] = [];
      // Paths of files (not folders) touched by the agent. Used to pick
      // which file to open in the editor after the run. `create_folder`
      // actions also produce `tool` events with a path, but that path is
      // a folder — passing it to `selectFile` would try to `cat` a folder
      // key and fail with "Could not open X", so we filter them out here.
      const changedFilePaths: string[] = [];
      // Set to true when we observe a terminal event (`complete` or
      // `error`). If the stream ends without ever setting this, the
      // request was interrupted (Lambda timeout, network drop, etc.) and
      // the finally block shows a warning instead of leaving the UI in
      // an in-progress state forever.
      let sawTerminalEvent = false;

      try {
        for await (const event of streamAgent({
          message: userMessage,
          conversationHistory: historyForAgent,
        })) {
          if (event.type === "tool") {
            const toolLabel = (() => {
              switch (event.tool) {
                case "write_file":     return t("tmpl.toolWrote", { path: event.path });
                case "delete_file":    return t("tmpl.toolDeleted", { path: event.path });
                case "move_file":      return t("tmpl.toolMoved", { from: event.from, to: event.path });
                case "create_folder":  return t("tmpl.toolCreatedFolder", { path: event.path });
                default:               return `${event.tool} ${event.path ?? ""}`.trim();
              }
            })();
            toolLines.push(`- ${toolLabel}`);
            if (event.path && event.tool !== "create_folder") {
              changedFilePaths.push(event.path);
            }
            // Refresh the tree immediately after each file operation so the
            // user sees changes as they happen (not only when the agent finishes).
            // Fire-and-forget: the final refresh in `finally` is the source of
            // truth; these incremental updates just improve perceived liveness.
            refreshTree().catch(() => {});
            // A tool event means a round just completed, so any retry
            // counter from a prior round's backoffs should be cleared.
            updateLast((m) => ({
              ...m,
              text: toolLines.join("\n"),
              retryCount: undefined,
              retryMax: undefined,
            }));
          } else if (event.type === "retry") {
            // Bedrock just failed and is about to back off. Surface the
            // counter so the user knows where the wait is coming from.
            // `attempt` is 1-based and represents the attempt that JUST
            // failed, so the next attempt is attempt+1.
            updateLast((m) => ({
              ...m,
              retryCount: event.attempt,
              retryMax: event.maxAttempts,
            }));
          } else if (event.type === "complete") {
            sawTerminalEvent = true;
            const finalText = toolLines.length
              ? `${event.message}\n\n${toolLines.join("\n")}`
              : event.message;
            updateLast((m) => ({
              ...m,
              text: finalText,
              inProgress: false,
              retryCount: undefined,
              retryMax: undefined,
            }));
          } else if (event.type === "error") {
            sawTerminalEvent = true;
            // Preserve tool summaries if any files were written before the
            // error — the agent may have made partial progress (e.g. wrote
            // 3 templates then hit ThrottlingException on the 4th). Wiping
            // the text here would hide that progress from the user.
            const errorText = toolLines.length
              ? `${toolLines.join("\n")}\n\nError: ${event.message}`
              : `Error: ${event.message}`;
            updateLast((m) => ({
              ...m,
              text: errorText,
              inProgress: false,
              retryCount: undefined,
              retryMax: undefined,
            }));
            setError(event.message);
          }
        }
      } catch (err) {
        sawTerminalEvent = true;
        const msg =
          err instanceof Error ? err.message : t("tmpl.errorFallback");
        const errorText = toolLines.length
          ? `${toolLines.join("\n")}\n\nError: ${msg}`
          : `Error: ${msg}`;
        updateLast((m) => ({
          ...m,
          text: errorText,
          inProgress: false,
          retryCount: undefined,
          retryMax: undefined,
        }));
        setError(msg);
      } finally {
        // If the stream ended without a terminal event, the request was
        // interrupted mid-flight (Lambda hit its timeout, network dropped,
        // etc.). Without this, the assistant message would stay stuck
        // with inProgress=true forever, making the UI look hung.
        if (!sawTerminalEvent) {
          const interruptedMessage = t("tmpl.interrupted");
          const interruptedText = toolLines.length
            ? `${toolLines.join("\n")}\n\n${interruptedMessage}`
            : interruptedMessage;
          updateLast((m) => ({
            ...m,
            text: interruptedText,
            inProgress: false,
            retryCount: undefined,
            retryMax: undefined,
          }));
          setError(interruptedMessage);
        }

        // Always refresh the tree after the stream ends — even on error.
        // The agent may have made partial progress (written some files
        // before hitting a throttle), and the file tree should reflect
        // what's actually in S3 regardless of whether the loop finished
        // cleanly. Refresh is best-effort: a failure here shouldn't mask
        // the original error the user already sees.
        try {
          await refreshTree();
          if (changedFilePaths.length > 0) {
            await selectFile(changedFilePaths[0]);
          }
        } catch (refreshErr) {
          console.warn("post-agent refresh failed", refreshErr);
        }
        setIsProcessing(false);
        inputRef.current?.focus();
        setTimeout(
          () => chatEndRef.current?.scrollIntoView({ behavior: "smooth" }),
          50
        );
      }
    },
    [input, isProcessing, messages, refreshTree, selectFile, t]
  );

  const handleChatKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // -------------------------------------------------------------------------
  // Context menu actions
  // -------------------------------------------------------------------------

  const openContextMenu = useCallback(
    (e: ReactMouseEvent, node: TreeNode) => {
      e.preventDefault();
      e.stopPropagation();
      const btn = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setContextMenu({ x: btn.left, y: btn.bottom + 2, node });
    },
    []
  );

  const ctxNewFile = useCallback(() => {
    if (!contextMenu) return;
    const parent = contextMenu.node.isDirectory
      ? contextMenu.node.path
      : contextMenu.node.path.split("/").slice(0, -1).join("/");
    setInlineInput({ parentPath: parent, type: "file" });
    setInlineValue("");
    setContextMenu(null);
  }, [contextMenu]);

  const ctxNewFolder = useCallback(() => {
    if (!contextMenu) return;
    const parent = contextMenu.node.isDirectory
      ? contextMenu.node.path
      : contextMenu.node.path.split("/").slice(0, -1).join("/");
    setInlineInput({ parentPath: parent, type: "folder" });
    setInlineValue("");
    setContextMenu(null);
  }, [contextMenu]);

  const ctxRename = useCallback(() => {
    if (!contextMenu) return;
    setRenamingPath(contextMenu.node.path);
    setRenameValue(contextMenu.node.name);
    setContextMenu(null);
  }, [contextMenu]);

  const ctxDelete = useCallback(() => {
    if (!contextMenu) return;
    handleDelete(contextMenu.node.path, contextMenu.node.isDirectory);
    setContextMenu(null);
  }, [contextMenu, handleDelete]);

  // -------------------------------------------------------------------------
  // Render tree node
  // -------------------------------------------------------------------------

  const renderNode = (node: TreeNode, depth: number = 0) => {
    const isRenaming = renamingPath === node.path;
    const isDropHover = dropTarget === node.path;
    const showInlineUnder =
      inlineInput &&
      node.isDirectory &&
      node.path === inlineInput.parentPath;

    return (
      <div key={node.path}>
        <div
          data-tree-path={node.path}
          draggable={!isRenaming}
          onDragStart={(e) => handleDragStart(e, node.path)}
          onDragOver={(e) => handleDragOver(e, node)}
          onDragLeave={handleDragLeave}
          onDrop={(e) => handleDrop(e, node)}
          onDragEnd={handleDragEnd}
          className={`group flex items-center gap-1 px-2 py-1 cursor-pointer text-sm transition-colors ${
            selectedPath === node.path && !node.isDirectory
              ? "bg-blue-50 text-blue-700"
              : isDropHover
                ? "bg-blue-100"
                : "text-gray-700 hover:bg-gray-100"
          }`}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() => {
            if (node.isDirectory) toggleDir(node.path);
            else selectFile(node.path);
          }}
        >
          {/* Chevron / blank */}
          <span className="text-xs w-4 text-center flex-shrink-0 text-gray-400">
            {node.isDirectory ? (node.expanded ? "\u25BE" : "\u25B8") : ""}
          </span>

          {/* Name or rename input */}
          {isRenaming ? (
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={() => setRenamingPath(null)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRename(node.path, renameValue);
                else if (e.key === "Escape") setRenamingPath(null);
              }}
              onClick={(e) => e.stopPropagation()}
              className="flex-1 min-w-0 text-xs border border-blue-400 rounded px-1 py-0 outline-none font-mono"
            />
          ) : (
            <span className="flex-1 min-w-0 truncate font-mono text-xs">
              {node.isDirectory ? `${node.name}/` : node.name}
            </span>
          )}

          {/* Three-dot menu trigger */}
          {!isRenaming && (
            <button
              onClick={(e) => openContextMenu(e, node)}
              className="opacity-0 group-hover:opacity-100 p-0.5 text-gray-400 hover:text-gray-700 flex-shrink-0"
              title={t("tmpl.actionsTitle")}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <circle cx="12" cy="5" r="2" />
                <circle cx="12" cy="12" r="2" />
                <circle cx="12" cy="19" r="2" />
              </svg>
            </button>
          )}
        </div>

        {/* Inline input for creating file/folder inside this directory */}
        {showInlineUnder && node.expanded && (
          <div
            className="flex items-center gap-1 px-2 py-1"
            style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
          >
            <span className="text-xs w-4 text-center flex-shrink-0 text-gray-300">
              {inlineInput.type === "folder" ? "\u25B8" : ""}
            </span>
            <input
              autoFocus
              value={inlineValue}
              onChange={(e) => setInlineValue(e.target.value)}
              onBlur={() => {
                setInlineInput(null);
                setInlineValue("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleInlineCreate(inlineInput.type);
                else if (e.key === "Escape") {
                  setInlineInput(null);
                  setInlineValue("");
                }
              }}
              placeholder={
                inlineInput.type === "folder" ? t("tmpl.folderPlaceholder") : t("tmpl.filePlaceholder")
              }
              className="flex-1 min-w-0 text-xs border border-blue-400 rounded px-1 py-0.5 outline-none font-mono"
            />
          </div>
        )}

        {/* Children */}
        {node.isDirectory &&
          node.expanded &&
          node.children?.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  // -------------------------------------------------------------------------
  // Render: inline input at root level (when parentPath is "")
  // -------------------------------------------------------------------------

  const showRootInline = inlineInput && inlineInput.parentPath === "";

  // -------------------------------------------------------------------------
  // JSX
  // -------------------------------------------------------------------------

  return (
    <div ref={containerRef} className="flex h-full">
      {/* NOTE: `select-none` used to live on this container so dragging the
          resize handles wouldn't accidentally select text across the whole
          page. That was too broad — it also killed selection inside the
          chat bubbles. The resize handlers below already toggle
          `document.body.style.userSelect = "none"` for the duration of an
          active drag (see onResizeStart), which solves the original problem
          without disabling selection everywhere else. */}
      {/* LEFT: AI Chat */}
      <div
        className="border-r border-gray-200 bg-white flex flex-col flex-shrink-0"
        style={{ width: leftWidth }}
      >
        <div className="p-3 border-b border-gray-200">
          <h2 className="text-sm font-semibold text-gray-700">{t("tmpl.agentTitle")}</h2>
        </div>

        <div
          ref={chatScrollRef}
          className="flex-1 overflow-y-auto p-3 space-y-3"
        >
          {messages.length === 0 && (
            <div className="text-center text-gray-400 text-sm mt-8 px-2">
              <p className="mb-2 font-medium text-gray-500">
                {t("tmpl.agentEmptyHeading")}
              </p>
              <p className="text-xs">
                {t("tmpl.agentEmptyExamples")}
              </p>
            </div>
          )}
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`text-sm ${
                msg.role === "user" ? "text-gray-800" : "text-gray-600"
              }`}
            >
              <span
                className={`inline-block text-xs font-medium mb-0.5 ${
                  msg.role === "user" ? "text-blue-600" : "text-gray-400"
                }`}
              >
                {msg.role === "user" ? t("tmpl.youLabel") : t("tmpl.agentLabel")}
              </span>
              {msg.text && (
                <p className="whitespace-pre-wrap break-words">{msg.text}</p>
              )}
              {/* In-progress indicator: shown until the `complete` event
                  finalizes this message. We render it inline (not as a
                  separate row) so streamed tool summaries and the spinner
                  share the same chat bubble. */}
              {msg.inProgress && !msg.retryCount && (
                <p className="text-gray-400 animate-pulse mt-0.5">
                  {msg.text ? t("tmpl.working") : t("tmpl.thinking")}
                </p>
              )}
              {/* Retry counter: shown only when the wrapper is currently
                  backing off. The amber color makes it visually distinct
                  from a hard error and from the normal spinner. */}
              {msg.inProgress && msg.retryCount && msg.retryMax && (
                <p className="text-amber-600 mt-0.5">
                  {t("tmpl.aiBusy", { count: msg.retryCount, max: msg.retryMax })}
                </p>
              )}
            </div>
          ))}
          <div ref={chatEndRef} />
        </div>

        {error && (
          <div className="mx-3 mb-2 p-2 bg-red-50 border border-red-200 rounded text-red-700 text-xs">
            {error}
          </div>
        )}

        <div className="p-3 border-t border-gray-200">
          <form onSubmit={handleSend} className="flex gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleChatKeyDown}
              placeholder={t("tmpl.agentPlaceholder")}
              rows={2}
              disabled={isProcessing}
              className="flex-1 resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!input.trim() || isProcessing}
              className="self-end px-3 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {t("tmpl.send")}
            </button>
          </form>
        </div>
      </div>

      {/* LEFT resize handle */}
      <div
        className="w-1 cursor-col-resize bg-transparent hover:bg-blue-300 active:bg-blue-400 transition-colors flex-shrink-0"
        onMouseDown={(e) => onResizeStart("left", e)}
      />

      {/* CENTER: Editor */}
      <div className="flex-1 flex flex-col overflow-hidden bg-gray-50 min-w-0">
        {selectedPath ? (
          <>
            <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200 bg-white">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-sm font-mono text-gray-700 truncate">
                  {selectedPath}
                </span>
                {isLoadingFile && <InlineSpinner />}
                {isDirty && (
                  <span className="text-xs text-amber-600 font-medium">
                    {t("tmpl.unsaved")}
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                {isDirty && (
                  <button
                    onClick={handleDiscard}
                    className="px-3 py-1.5 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-100 transition-colors"
                  >
                    {t("tmpl.discard")}
                  </button>
                )}
                <button
                  onClick={handleSave}
                  disabled={!isDirty || isSaving || isLoadingFile}
                  className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {isSaving ? t("tmpl.saving") : t("tmpl.save")}
                </button>
              </div>
            </div>
            {isLoadingFile ? (
              <div className="flex-1 flex items-center justify-center text-gray-400 text-sm gap-2">
                <InlineSpinner />
                <span>{t("tmpl.loadingFile", { path: selectedPath })}</span>
              </div>
            ) : (
              <textarea
                value={editorContent}
                onChange={(e) => setEditorContent(e.target.value)}
                className="flex-1 w-full p-4 text-sm font-mono text-gray-800 bg-white focus:outline-none resize-none"
                spellCheck={false}
              />
            )}
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-gray-400 text-sm">
            {t("tmpl.selectFile")}
          </div>
        )}
      </div>

      {/* RIGHT resize handle */}
      <div
        className="w-1 cursor-col-resize bg-transparent hover:bg-blue-300 active:bg-blue-400 transition-colors flex-shrink-0"
        onMouseDown={(e) => onResizeStart("right", e)}
      />

      {/* RIGHT: File tree */}
      <div
        className="border-l border-gray-200 bg-white flex flex-col flex-shrink-0"
        style={{ width: rightWidth }}
      >
        <div className="p-3 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
            {t("tmpl.filesTitle")}
          </h2>
          <div className="flex gap-1">
            <button
              onClick={() => {
                setInlineInput({ parentPath: "", type: "file" });
                setInlineValue("");
              }}
              className="px-1.5 py-0.5 text-xs text-gray-500 hover:text-blue-600 border border-gray-300 rounded transition-colors"
              title={t("tmpl.newFileTitle")}
            >
              {t("tmpl.newFile")}
            </button>
            <button
              onClick={() => {
                setInlineInput({ parentPath: "", type: "folder" });
                setInlineValue("");
              }}
              className="px-1.5 py-0.5 text-xs text-gray-500 hover:text-blue-600 border border-gray-300 rounded transition-colors"
              title={t("tmpl.newFolderTitle")}
            >
              {t("tmpl.newDir")}
            </button>
          </div>
        </div>

        {/* Root inline input */}
        {showRootInline && (
          <div className="px-2 py-2 border-b border-gray-100">
            <input
              autoFocus
              value={inlineValue}
              onChange={(e) => setInlineValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter")
                  handleInlineCreate(inlineInput!.type);
                if (e.key === "Escape") {
                  setInlineInput(null);
                  setInlineValue("");
                }
              }}
              onBlur={() => {
                setInlineInput(null);
                setInlineValue("");
              }}
              placeholder={
                inlineInput!.type === "folder" ? t("tmpl.folderPlaceholder") : t("tmpl.filePlaceholder")
              }
              className="w-full text-xs border border-blue-400 rounded px-2 py-1 outline-none font-mono"
            />
          </div>
        )}

        {/* Tree */}
        <div
          ref={treeScrollAreaRef}
          className="flex-1 overflow-y-auto py-1"
          onDragOver={(e) => {
            if (dragSource) {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }
          }}
          onDrop={handleRootDrop}
        >
          {isLoadingTree ? (
            <div className="px-3 py-4 flex items-center justify-center gap-2 text-xs text-gray-400">
              <InlineSpinner />
              <span>{t("tmpl.loadingFiles")}</span>
            </div>
          ) : (
            <>
              {tree.length === 0 && !showRootInline && (
                <div className="p-3 text-xs text-gray-400 text-center mt-4">
                  {t("tmpl.noFiles")}
                </div>
              )}
              {tree.map((node) => renderNode(node))}
            </>
          )}
        </div>
      </div>

      {/* Context menu (floating, clamped to viewport) */}
      {contextMenu && (
        <div
          className="fixed bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50 min-w-[140px]"
          style={{
            left: Math.min(contextMenu.x, window.innerWidth - 160),
            top: Math.min(contextMenu.y, window.innerHeight - 180),
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <CtxItem label={t("tmpl.ctxNewFile")} onClick={ctxNewFile} />
          <CtxItem label={t("tmpl.ctxNewFolder")} onClick={ctxNewFolder} />
          <div className="border-t border-gray-100 my-1" />
          <CtxItem label={t("tmpl.ctxRename")} onClick={ctxRename} />
          <CtxItem label={t("tmpl.ctxDelete")} onClick={ctxDelete} danger />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Small spinning SVG used for file-cat and initial-tree-load feedback. Kept
// self-contained (no external icon dep) and sized small enough to sit next
// to text without pushing layout around.
function InlineSpinner() {
  return (
    <svg
      className="animate-spin text-gray-400"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
        strokeOpacity="0.25"
      />
      <path
        d="M12 2a10 10 0 0 1 10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CtxItem({
  label,
  onClick,
  danger,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
      className={`w-full text-left px-3 py-1.5 text-sm transition-colors ${
        danger
          ? "text-red-600 hover:bg-red-50"
          : "text-gray-700 hover:bg-gray-100"
      }`}
    >
      {label}
    </button>
  );
}
