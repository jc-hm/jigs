import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";

interface Usage {
  daily: { reportCount: number };
  monthly: { reportCount: number; totalCostUsd: number };
  balance: {
    balanceUsd: number;
    topUpsUsd: number;
    spentUsd: number;
    reportsLifetime: number;
  };
}

export function Profile() {
  const [usage, setUsage] = useState<Usage>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    apiFetch<Usage>("/billing/usage")
      .then(setUsage)
      .catch((e) => setError(e.message));
  }, []);

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-semibold text-gray-800 mb-6">Profile</h1>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm mb-4">
          {error}
        </div>
      )}

      {usage && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="text-sm text-gray-500">Balance</div>
            <div className="text-2xl font-semibold text-gray-800">
              ${usage.balance.balanceUsd.toFixed(2)}
            </div>
            <div className="text-xs text-gray-400">remaining credit</div>
          </div>
          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="text-sm text-gray-500">Total Reports</div>
            <div className="text-2xl font-semibold text-gray-800">
              {usage.balance.reportsLifetime}
            </div>
            <div className="text-xs text-gray-400">lifetime</div>
          </div>
          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="text-sm text-gray-500">Total Cost</div>
            <div className="text-2xl font-semibold text-gray-800">
              ${usage.balance.spentUsd.toFixed(2)}
            </div>
            <div className="text-xs text-gray-400">lifetime AI inference</div>
          </div>
        </div>
      )}
    </div>
  );
}
