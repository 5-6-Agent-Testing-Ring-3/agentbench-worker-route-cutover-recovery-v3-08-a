import { mkdir, readFile, rename, open, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { canonical, ensure, hash, object, SafetyError } from "./safety.js";
import { parseDeployment } from "./cloudflare-client.js";
import type { Journal } from "./types.js";

const nodeProcess = (
  globalThis as unknown as {
    process: { argv: string[]; exitCode: number | undefined; pid: number };
  }
).process;

export class JournalStore {
  constructor(private readonly path: string) {}
  async read(): Promise<Journal | null> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new SafetyError("Cannot read recovery journal");
    }
    try {
      const envelope = object(JSON.parse(text) as unknown);
      const j = object(envelope.journal);
      ensure(
        envelope.checksum === hash(canonical(j)) &&
          j.schemaVersion === 2 &&
          typeof j.scope === "string" &&
          typeof j.bundleHash === "string" &&
          typeof j.runId === "string" &&
          typeof j.startedAt === "string" &&
          Array.isArray(j.transitions) &&
          j.transitions.length > 0 &&
          typeof j.phase === "string",
        "Incomplete or corrupt recovery journal",
      );
      ensure(
        [
          "prepared",
          "uploading",
          "uploaded",
          "deploying",
          "deployed",
          "canary-intent",
          "canary-ready",
          "validated",
          "cutover-intent",
          "production-verified",
          "cleanup-intent",
          "complete",
          "rollback-intent",
          "rolled-back",
        ].includes(j.phase),
        "Unknown journal phase",
      );
      const b = object(j.baseline);
      for (const key of [
        "productionRoute",
        "stableDeployment",
        "candidateDeployment",
        "stableSettings",
        "candidateSettings",
      ])
        object(b[key]);
      ensure(
        b.canaryRoute === null || typeof b.canaryRoute === "object",
        "Incomplete canary baseline",
      );
      for (const key of [
        "candidateVersionId",
        "candidateDeploymentId",
        "restoredCandidateDeploymentId",
        "ownedCanaryId",
      ])
        ensure(
          j[key] === null || typeof j[key] === "string",
          "Incomplete recovery identifiers",
        );
      const digest = (value: unknown) =>
        ensure(
          typeof value === "string" && /^[a-f0-9]{64}$/u.test(value),
          "Invalid recovery digest",
        );
      digest(j.scope);
      digest(j.bundleHash);
      for (const key of ["productionRoute", "canaryRoute"]) {
        if (b[key] === null) continue;
        const route = object(b[key]);
        ensure(
          typeof route.id === "string" &&
            /^[\w-]+$/u.test(route.id) &&
            route.pattern ===
              (key === "productionRoute" ? "production" : "canary") &&
            ["stable", "candidate", null].includes(
              route.script as string | null,
            ),
          "Invalid recovery route",
        );
      }
      for (const key of ["stableDeployment", "candidateDeployment"])
        parseDeployment(b[key]);
      for (const key of ["stableSettings", "candidateSettings"]) {
        const settings = object(b[key]);
        digest(settings.fingerprint);
        const identity = object(settings.identity);
        digest(identity.versionHash);
        digest(identity.workerHash);
        ensure(
          Array.isArray(settings.bindingTypes) &&
            settings.bindingTypes.every(
              (type: unknown) => typeof type === "string",
            ) &&
            typeof settings.compatibilityDate === "string",
          "Incomplete recovery settings",
        );
      }
      ensure(
        Number.isFinite(Date.parse(j.startedAt)),
        "Invalid recovery timestamp",
      );
      for (const value of j.transitions) {
        const transition = object(value);
        ensure(
          typeof transition.phase === "string" &&
            typeof transition.at === "string" &&
            Number.isFinite(Date.parse(transition.at)),
          "Incomplete recovery transition",
        );
      }
      return j as unknown as Journal;
    } catch {
      throw new SafetyError(
        "Incomplete or corrupt recovery journal; preserve it and inspect live status",
      );
    }
  }
  async write(journal: Journal): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp`;
    const file = await open(temporary, "w", 0o600);
    try {
      await file.writeFile(
        `${JSON.stringify({ checksum: hash(canonical(journal)), journal }, null, 2)}\n`,
        "utf8",
      );
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, this.path);
    const directory = await open(dirname(this.path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  async withLock<T>(scope: string, work: () => Promise<T>): Promise<T> {
    ensure(/^[a-f0-9]{64}$/u.test(scope), "Invalid lock scope");
    // A per-user scope lock excludes processes in different repository checkouts.
    const path = join(tmpdir(), `worker-route-cutover-${scope}.lock`);
    try {
      await mkdir(path, { mode: 0o700 });
    } catch {
      throw new SafetyError(
        "Concurrent rollout or abandoned lock; inspect the scoped lock in the OS temporary directory. Remove only after confirming its owner has stopped",
      );
    }
    try {
      await writeFile(
        join(path, "owner.json"),
        JSON.stringify({
          pid: nodeProcess.pid,
          startedAt: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );
      return await work();
    } finally {
      await rm(path, { recursive: true });
    }
  }
}
