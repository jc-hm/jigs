import { useState, useEffect, useCallback } from "react";
import {
  adminGetOverview,
  adminTopup,
  adminForceLogout,
  type AdminOrg,
  type AdminUser,
  type AdminOverview,
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

export function Admin() {
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
          <button
            onClick={load}
            className="px-3 py-1.5 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-white transition-colors"
          >
            Refresh
          </button>
        </div>

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
      </div>
    </div>
  );
}
