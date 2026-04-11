import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../app.js";
import { seedTestData, injectMockAI, resetMockAI } from "../../test/helpers/setup.js";
import { parseSSE } from "../../test/helpers/sse.js";
import type { AgentEvent } from "../services/ai/types.js";

describe("Template file API", () => {
  beforeAll(async () => {
    process.env.STAGE = "local";
    injectMockAI();
    await seedTestData();
  });

  afterAll(() => {
    resetMockAI();
  });

  describe("GET /api/v1/templates/ls", () => {
    it("lists root directory with seed templates", async () => {
      const res = await app.request("/api/v1/templates/ls?path=/");
      expect(res.status).toBe(200);
      const entries = await res.json();
      expect(entries).toBeInstanceOf(Array);
      expect(entries.length).toBeGreaterThan(0);
      // Seed templates should be present
      const names = entries.map((e: { path: string }) => e.path);
      expect(names).toContain("mri-knee.md");
    });

    it("lists empty directory when path does not exist", async () => {
      const res = await app.request("/api/v1/templates/ls?path=/nonexistent");
      expect(res.status).toBe(200);
      const entries = await res.json();
      expect(entries).toEqual([]);
    });
  });

  describe("GET /api/v1/templates/cat", () => {
    it("reads a seed template file", async () => {
      const res = await app.request("/api/v1/templates/cat?path=mri-knee.md");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.path).toBe("mri-knee.md");
      expect(body.content).toContain("MRI Knee");
    });

    it("returns 400 without path", async () => {
      const res = await app.request("/api/v1/templates/cat");
      expect(res.status).toBe(400);
    });

    it("returns 404 for missing file", async () => {
      const res = await app.request("/api/v1/templates/cat?path=nonexistent");
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /api/v1/templates/write", () => {
    it("creates a new file", async () => {
      const res = await app.request("/api/v1/templates/write", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "test-new-file", content: "hello world" }),
      });
      expect(res.status).toBe(200);

      // Verify we can read it back
      const readRes = await app.request("/api/v1/templates/cat?path=test-new-file");
      expect(readRes.status).toBe(200);
      const body = await readRes.json();
      expect(body.content).toBe("hello world");
    });

    it("updates an existing file", async () => {
      await app.request("/api/v1/templates/write", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "test-update", content: "v1" }),
      });
      await app.request("/api/v1/templates/write", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "test-update", content: "v2" }),
      });

      const readRes = await app.request("/api/v1/templates/cat?path=test-update");
      const body = await readRes.json();
      expect(body.content).toBe("v2");
    });

    it("returns 400 without path", async () => {
      const res = await app.request("/api/v1/templates/write", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "", content: "x" }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/v1/templates/rm", () => {
    it("deletes a file", async () => {
      // Create then delete
      await app.request("/api/v1/templates/write", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "to-delete", content: "bye" }),
      });
      const rmRes = await app.request("/api/v1/templates/rm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "to-delete" }),
      });
      expect(rmRes.status).toBe(200);

      // Should be gone
      const catRes = await app.request("/api/v1/templates/cat?path=to-delete");
      expect(catRes.status).toBe(404);
    });
  });

  describe("POST /api/v1/templates/mv", () => {
    it("moves/renames a file", async () => {
      await app.request("/api/v1/templates/write", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "original-name", content: "data" }),
      });

      const mvRes = await app.request("/api/v1/templates/mv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: "original-name", to: "new-name" }),
      });
      expect(mvRes.status).toBe(200);

      // Old path gone
      const oldRes = await app.request("/api/v1/templates/cat?path=original-name");
      expect(oldRes.status).toBe(404);

      // New path has content
      const newRes = await app.request("/api/v1/templates/cat?path=new-name");
      expect(newRes.status).toBe(200);
      const body = await newRes.json();
      expect(body.content).toBe("data");
    });
  });

  describe("POST /api/v1/templates/mkdir", () => {
    it("creates a folder visible in ls", async () => {
      await app.request("/api/v1/templates/mkdir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "test-folder" }),
      });

      // Create a file inside the folder to verify it shows up
      await app.request("/api/v1/templates/write", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "test-folder/inner-file", content: "inside" }),
      });

      // List root should show the folder
      const lsRes = await app.request("/api/v1/templates/ls?path=/");
      const entries = await lsRes.json();
      const folder = entries.find(
        (e: { path: string; isDirectory: boolean }) =>
          e.path === "test-folder" && e.isDirectory
      );
      expect(folder).toBeDefined();

      // List folder should show the file
      const innerRes = await app.request("/api/v1/templates/ls?path=test-folder");
      const innerEntries = await innerRes.json();
      const file = innerEntries.find(
        (e: { path: string }) => e.path === "inner-file"
      );
      expect(file).toBeDefined();
    });
  });

  describe("POST /api/v1/templates/agent", () => {
    it("streams tool and complete events from the agent loop", async () => {
      const res = await app.request("/api/v1/templates/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "create a new brain MRI template" }),
      });
      expect(res.status).toBe(200);

      const text = await res.text();
      const events = parseSSE<AgentEvent>(text);

      // At least one tool call landed and a terminal complete event arrived.
      const toolEvents = events.filter((e) => e.type === "tool");
      expect(toolEvents.length).toBeGreaterThan(0);

      const complete = events.find((e) => e.type === "complete");
      expect(complete).toBeDefined();
      if (complete?.type === "complete") {
        expect(complete.message).toBeDefined();
        expect(complete.changedPaths).toBeInstanceOf(Array);
      }
    });

    it("returns 400 without message", async () => {
      const res = await app.request("/api/v1/templates/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "" }),
      });
      expect(res.status).toBe(400);
    });
  });
});
