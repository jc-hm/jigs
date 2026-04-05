import { useState } from "react";
import { Fill } from "./pages/Fill";
import { Templates } from "./pages/Templates";
import { Profile } from "./pages/Profile";

type Page = "fill" | "templates" | "profile";

function App() {
  const [page, setPage] = useState<Page>("fill");

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Sidebar */}
      <nav className="w-56 bg-white border-r border-gray-200 flex flex-col">
        <div className="p-4 border-b border-gray-200">
          <h1 className="text-lg font-bold text-gray-800">Jigs</h1>
        </div>
        <div className="flex-1 p-2 space-y-1">
          <NavItem
            label="Fill Report"
            active={page === "fill"}
            onClick={() => setPage("fill")}
          />
          <NavItem
            label="Templates"
            active={page === "templates"}
            onClick={() => setPage("templates")}
          />
          <NavItem
            label="Profile"
            active={page === "profile"}
            onClick={() => setPage("profile")}
          />
        </div>
      </nav>

      {/* Main content */}
      <main className="flex-1 overflow-hidden">
        {page === "fill" && <Fill />}
        {page === "templates" && <Templates />}
        {page === "profile" && <Profile />}
      </main>
    </div>
  );
}

function NavItem({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
        active
          ? "bg-blue-50 text-blue-700 font-medium"
          : "text-gray-600 hover:bg-gray-100"
      }`}
    >
      {label}
    </button>
  );
}

export default App;
