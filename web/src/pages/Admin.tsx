import { useState, useEffect, useCallback } from "react";
import {
  adminGetOverview,
  adminTopup,
  adminForceLogout,
  adminGetWaitlist,
  adminGetFeedback,
  adminMarkFeedbackRead,
  createInvite,
  type AdminOrg,
  type AdminUser,
  type AdminOverview,
  type AdminWaitlistEntry,
  type AdminFeedbackItem,
} from "../lib/api";
import { signOut } from "../lib/auth";

function formatDate(iso?: string): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

interface UserRowProps {
  org: AdminOrg;
  user: AdminUser;
  onRefresh: () => void;
}

function UserRow({ org, user, onRefresh }: UserRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [topupDir, setTopupDir] = useState<"add" | "subtract" | null>(null);
  const [topupAmount, setTopupAmount] = useState("");
  const [logoutConfirm, setLogoutConfirm] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleTopupConfirm = async () => {
    const amount = parseFloat(topupAmount);
    if (!isFinite(amount) || amount <= 0 || amount > 1000) {
      setError("Enter a number between 0.01 and 1000");
      return;
    }
    setWorking(true);
    setError(null);
    try {
      const delta = topupDir === "subtract" ? -amount : amount;
      await adminTopup(org.orgId, delta, `Admin ${topupDir} via dashboard`);
      setTopupDir(null);
      setTopupAmount("");
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setWorking(false);
    }
  };

  const handleLogout = async () => {
    setWorking(true);
    setError(null);
    try {
      await adminForceLogout(org.orgId, user.id);
      // Clear the local session immediately — Cognito's adminUserGlobalSignOut
      // invalidates the refresh token but the ID token stays valid until expiry.
      // Signing out locally ensures this browser session ends right away.
      await signOut();
      window.location.href = "/";
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
      setWorking(false);
    }
  };

  return (
    <>
      <tr
        className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer select-none"
        onClick={() => setExpanded((v) => !v)}
      >
        <td className="px-4 py-3 text-sm text-gray-700">{org.name}</td>
        <td className="px-4 py-3 text-sm text-gray-600">{user.email}</td>
        <td className="px-4 py-3 text-sm font-mono text-gray-700">
          {formatUsd(org.balance.balanceUsd)}
        </td>
        <td className="px-4 py-3 text-sm text-gray-600">
          {org.balance.reportsLifetime}
        </td>
        <td className="px-4 py-3 text-sm text-gray-400">
          {expanded ? "▲" : "▶"}
        </td>
      </tr>
      {expanded && (
        <tr className="bg-gray-50 border-b border-gray-100">
          <td colSpan={5} className="px-6 py-3">
            <div className="text-xs text-gray-500 mb-3">
              Last login: {formatDate(user.lastLoginAt)}
            </div>

            {error && (
              <div className="text-xs text-red-600 mb-2">{error}</div>
            )}

            <div className="flex items-center gap-2 flex-wrap">
              {topupDir === null ? (
                <>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setTopupDir("add");
                      setTopupAmount("");
                      setError(null);
                    }}
                    className="px-3 py-1.5 text-xs rounded-md bg-green-100 text-green-700 hover:bg-green-200 transition-colors"
                  >
                    + Add credit
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setTopupDir("subtract");
                      setTopupAmount("");
                      setError(null);
                    }}
                    className="px-3 py-1.5 text-xs rounded-md bg-orange-100 text-orange-700 hover:bg-orange-200 transition-colors"
                  >
                    − Subtract credit
                  </button>
                </>
              ) : (
                <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                  <span className="text-xs text-gray-500">
                    {topupDir === "add" ? "Add $" : "Subtract $"}
                  </span>
                  <input
                    type="number"
                    min="0.01"
                    max="1000"
                    step="0.01"
                    value={topupAmount}
                    onChange={(e) => setTopupAmount(e.target.value)}
                    className="w-24 px-2 py-1 text-xs border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
                    autoFocus
                  />
                  <button
                    onClick={handleTopupConfirm}
                    disabled={working}
                    className="px-3 py-1.5 text-xs rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
                  >
                    {working ? "Saving…" : "Confirm"}
                  </button>
                  <button
                    onClick={() => { setTopupDir(null); setError(null); }}
                    className="px-3 py-1.5 text-xs rounded-md text-gray-500 hover:bg-gray-200 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              )}

              {!logoutConfirm ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setLogoutConfirm(true);
                    setError(null);
                  }}
                  className="px-3 py-1.5 text-xs rounded-md bg-red-100 text-red-700 hover:bg-red-200 transition-colors"
                >
                  Force logout
                </button>
              ) : (
                <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                  <span className="text-xs text-gray-600">Log out {user.email}?</span>
                  <button
                    onClick={handleLogout}
                    disabled={working}
                    className="px-3 py-1.5 text-xs rounded-md bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
                  >
                    {working ? "Logging out…" : "Yes, logout"}
                  </button>
                  <button
                    onClick={() => setLogoutConfirm(false)}
                    className="px-3 py-1.5 text-xs rounded-md text-gray-500 hover:bg-gray-200 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function WaitlistTab() {
  const [entries, setEntries] = useState<AdminWaitlistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteSent, setInviteSent] = useState<Record<string, string>>({});

  useEffect(() => {
    adminGetWaitlist()
      .then((r) => setEntries(r.entries))
      .finally(() => setLoading(false));
  }, []);

  const handleInvite = async (email: string) => {
    try {
      const { code } = await createInvite(false);
      const link = `${window.location.origin}?invite=${code}`;
      setInviteSent((prev) => ({ ...prev, [email]: link }));
    } catch {
      // silent
    }
  };

  if (loading) return <p className="text-sm text-gray-400 py-8 text-center">Loading…</p>;
  if (entries.length === 0) return <p className="text-sm text-gray-400 py-8 text-center">No waitlist entries yet.</p>;

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <table className="w-full">
        <thead>
          <tr className="border-b border-gray-200 bg-gray-50">
            <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Email</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Requested</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Note</th>
            <th className="px-4 py-2.5 w-32" />
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.email} className="border-b border-gray-100 last:border-0">
              <td className="px-4 py-3 text-sm text-gray-700">{e.email}</td>
              <td className="px-4 py-3 text-sm text-gray-400">{formatDate(e.createdAt)}</td>
              <td className="px-4 py-3 text-sm text-gray-500">{e.note ?? "—"}</td>
              <td className="px-4 py-3 text-right">
                {inviteSent[e.email] ? (
                  <span
                    className="text-xs text-green-600 cursor-pointer"
                    title={inviteSent[e.email]}
                    onClick={() => navigator.clipboard?.writeText(inviteSent[e.email])}
                  >
                    Copy link ✓
                  </span>
                ) : (
                  <button
                    onClick={() => handleInvite(e.email)}
                    className="px-3 py-1 text-xs rounded-md bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors"
                  >
                    Send invite
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FeedbackTab() {
  const [items, setItems] = useState<AdminFeedbackItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async (cursor?: string) => {
    cursor ? setLoadingMore(true) : setLoading(true);
    try {
      const res = await adminGetFeedback(20, cursor);
      setItems((prev) => (cursor ? [...prev, ...res.items] : res.items));
      setNextCursor(res.nextCursor);
    } finally {
      cursor ? setLoadingMore(false) : setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleMarkRead = async (id: string) => {
    await adminMarkFeedbackRead(id);
    setItems((prev) => prev.map((i) => i.id === id ? { ...i, read: true } : i));
  };

  if (loading) return <p className="text-sm text-gray-400 py-8 text-center">Loading…</p>;
  if (items.length === 0) return <p className="text-sm text-gray-400 py-8 text-center">No feedback yet.</p>;

  return (
    <div className="space-y-2">
      {items.map((item) => {
        const sender = item.senderEmail ?? item.userId ?? "—";
        const isOpen = expanded === item.id;
        return (
          <div
            key={item.id}
            className={`bg-white rounded-lg border ${item.read ? "border-gray-100" : "border-blue-200"} overflow-hidden`}
          >
            <div
              className="px-4 py-3 flex items-center gap-3 cursor-pointer hover:bg-gray-50"
              onClick={() => setExpanded(isOpen ? null : item.id)}
            >
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${item.read ? "bg-gray-200" : "bg-blue-400"}`} />
              <span className="text-xs font-medium text-gray-500 w-16 shrink-0">{item.type}</span>
              <span className="text-sm text-gray-700 truncate flex-1">{item.content?.slice(0, 80) ?? (item.rating ? `${item.rating} reaction` : "—")}</span>
              <span className="text-xs text-gray-400 shrink-0">{sender}</span>
              <span className="text-xs text-gray-300 shrink-0">{formatDate(item.createdAt)}</span>
            </div>
            {isOpen && (
              <div className="border-t border-gray-100 px-4 py-3 bg-gray-50 space-y-2">
                {item.content && <p className="text-sm text-gray-700 whitespace-pre-wrap">{item.content}</p>}
                {item.context && (
                  <p className="text-xs text-gray-400">
                    page: {item.context.page ?? "—"}{item.context.requestId ? ` · request: ${item.context.requestId}` : ""}
                  </p>
                )}
                {!item.read && (
                  <button
                    onClick={() => handleMarkRead(item.id)}
                    className="text-xs text-blue-500 hover:text-blue-700 transition-colors"
                  >
                    Mark as read
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
      {nextCursor && (
        <button
          onClick={() => load(nextCursor)}
          disabled={loadingMore}
          className="w-full py-2 text-sm text-gray-400 hover:text-gray-600 transition-colors"
        >
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}

type AdminTab = "users" | "waitlist" | "feedback";

export function Admin() {
  const [tab, setTab] = useState<AdminTab>("users");
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await adminGetOverview();
      setOverview(data);
      setLastRefreshed(new Date());
    } catch (e) {
      if (e instanceof Error && e.message.includes("403")) {
        setError("Not authorized");
      } else {
        setError(e instanceof Error ? e.message : "Failed to load");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50">
        <p className="text-gray-400 text-sm">Loading…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50">
        <div className="text-center">
          <p className="text-gray-500 text-sm">{error}</p>
          {error !== "Not authorized" && (
            <button
              onClick={load}
              className="mt-3 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              Retry
            </button>
          )}
        </div>
      </div>
    );
  }

  const { orgs = [], aggregate } = overview!;

  // Flatten: one row per user, carrying org data
  const rows: Array<{ org: AdminOrg; user: AdminUser }> = orgs.flatMap((org) =>
    org.users.map((user) => ({ org, user }))
  );

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-lg font-bold text-gray-800">Admin</h1>
            {lastRefreshed && (
              <p className="text-xs text-gray-400 mt-0.5">
                Refreshed {lastRefreshed.toLocaleTimeString()}
              </p>
            )}
          </div>
          {tab === "users" && (
            <button
              onClick={load}
              className="px-3 py-1.5 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-white transition-colors"
            >
              Refresh
            </button>
          )}
        </div>

        {/* Tab bar */}
        <div className="flex gap-1 mb-6 border-b border-gray-200">
          {(["users", "waitlist", "feedback"] as AdminTab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
                tab === t
                  ? "border-blue-600 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {tab === "users" && (
          <>
            {/* Summary bar */}
            <div className="grid grid-cols-3 gap-4 mb-6">
              <div className="bg-white rounded-lg border border-gray-200 px-4 py-3">
                <p className="text-xs text-gray-500">Orgs</p>
                <p className="text-xl font-bold text-gray-800">{aggregate?.orgCount ?? 0}</p>
              </div>
              <div className="bg-white rounded-lg border border-gray-200 px-4 py-3">
                <p className="text-xs text-gray-500">Total balance</p>
                <p className="text-xl font-bold text-gray-800">
                  {formatUsd(aggregate?.totalBalanceUsd ?? 0)}
                </p>
              </div>
              <div className="bg-white rounded-lg border border-gray-200 px-4 py-3">
                <p className="text-xs text-gray-500">Total spent</p>
                <p className="text-xl font-bold text-gray-800">
                  {formatUsd(aggregate?.totalSpentUsd ?? 0)}
                </p>
              </div>
            </div>

            {/* Users table */}
            <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50">
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Org
                    </th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      User email
                    </th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Credit left
                    </th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Reports
                    </th>
                    <th className="px-4 py-2.5 w-8" />
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-sm text-gray-400">
                        No users yet
                      </td>
                    </tr>
                  ) : (
                    rows.map(({ org, user }) => (
                      <UserRow
                        key={`${org.orgId}-${user.id}`}
                        org={org}
                        user={user}
                        onRefresh={load}
                      />
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}

        {tab === "waitlist" && <WaitlistTab />}
        {tab === "feedback" && <FeedbackTab />}
      </div>
    </div>
  );
}
