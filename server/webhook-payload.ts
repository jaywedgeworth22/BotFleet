// GitHub webhook JSON is huge: every delivery repeats `repository`, `sender`,
// and `organization` with URL farms, and `check_run.output` / workflow jobs
// carry logs.  Pretty-printing that and folding distinct deliveries is what
// pushed Compiler's Antigravity fallback to 713 KB (argv-only print mode
// then rejected it; Grok ACP `session/prompt` timed out on the same blob).
// Keep the compile-gate fields (action, conclusion, branch, sha, check name,
// PR merged) and drop the rest.  Non-GitHub payloads stay intact, compact.

import { z } from "zod";

import type { JsonValue } from "./schema.ts";

export const MAX_EVENT_CHARS = 48_000;

export function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, JsonValue>;
}

export function pickStr(obj: Record<string, JsonValue> | undefined, key: string): string | undefined {
  const value = obj?.[key];
  return typeof value === "string" && value ? value : undefined;
}

function pickNum(obj: Record<string, JsonValue> | undefined, key: string): number | undefined {
  const value = obj?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pickBool(obj: Record<string, JsonValue> | undefined, key: string): boolean | undefined {
  const value = obj?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function assignDefined(out: Record<string, JsonValue>, key: string, value: JsonValue | undefined): void {
  if (value !== undefined) out[key] = value;
}

function slimActor(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "login", pickStr(rec, "login"));
  assignDefined(out, "type", pickStr(rec, "type"));
  assignDefined(out, "id", pickNum(rec, "id"));
  return Object.keys(out).length ? out : undefined;
}

/** GitHub push `pusher` is `{ name, email }`, not a User actor. */
function slimPusher(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "name", pickStr(rec, "name"));
  assignDefined(out, "email", pickStr(rec, "email"));
  assignDefined(out, "login", pickStr(rec, "login"));
  return Object.keys(out).length ? out : undefined;
}

function slimRepo(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "full_name", pickStr(rec, "full_name"));
  assignDefined(out, "name", pickStr(rec, "name"));
  assignDefined(out, "html_url", pickStr(rec, "html_url"));
  assignDefined(out, "default_branch", pickStr(rec, "default_branch"));
  assignDefined(out, "private", pickBool(rec, "private"));
  assignDefined(out, "fork", pickBool(rec, "fork"));
  assignDefined(out, "owner", slimActor(rec.owner));
  return Object.keys(out).length ? out : undefined;
}

function slimShaRef(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "ref", pickStr(rec, "ref"));
  assignDefined(out, "sha", pickStr(rec, "sha"));
  assignDefined(out, "label", pickStr(rec, "label"));
  assignDefined(out, "repo", slimRepo(rec.repo));
  return Object.keys(out).length ? out : undefined;
}

function slimPullRequest(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "number", pickNum(rec, "number"));
  assignDefined(out, "title", pickStr(rec, "title"));
  assignDefined(out, "html_url", pickStr(rec, "html_url"));
  assignDefined(out, "state", pickStr(rec, "state"));
  assignDefined(out, "merge_commit_sha", pickStr(rec, "merge_commit_sha"));
  assignDefined(out, "merged", pickBool(rec, "merged"));
  assignDefined(out, "draft", pickBool(rec, "draft"));
  assignDefined(out, "user", slimActor(rec.user));
  assignDefined(out, "base", slimShaRef(rec.base));
  assignDefined(out, "head", slimShaRef(rec.head));
  return Object.keys(out).length ? out : undefined;
}

function slimIssue(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "number", pickNum(rec, "number"));
  assignDefined(out, "title", pickStr(rec, "title"));
  assignDefined(out, "html_url", pickStr(rec, "html_url"));
  assignDefined(out, "state", pickStr(rec, "state"));
  assignDefined(out, "user", slimActor(rec.user));
  return Object.keys(out).length ? out : undefined;
}

function slimCheckSuiteBrief(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "id", pickNum(rec, "id"));
  assignDefined(out, "head_sha", pickStr(rec, "head_sha"));
  assignDefined(out, "head_branch", pickStr(rec, "head_branch"));
  return Object.keys(out).length ? out : undefined;
}

function slimCheckRun(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "id", pickNum(rec, "id"));
  assignDefined(out, "name", pickStr(rec, "name"));
  assignDefined(out, "status", pickStr(rec, "status"));
  assignDefined(out, "conclusion", pickStr(rec, "conclusion"));
  assignDefined(out, "html_url", pickStr(rec, "html_url"));
  assignDefined(out, "details_url", pickStr(rec, "details_url"));
  assignDefined(out, "started_at", pickStr(rec, "started_at"));
  assignDefined(out, "completed_at", pickStr(rec, "completed_at"));
  assignDefined(out, "head_sha", pickStr(rec, "head_sha"));
  assignDefined(out, "check_suite", slimCheckSuiteBrief(rec.check_suite));
  return Object.keys(out).length ? out : undefined;
}

function slimCheckSuite(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "id", pickNum(rec, "id"));
  assignDefined(out, "status", pickStr(rec, "status"));
  assignDefined(out, "conclusion", pickStr(rec, "conclusion"));
  assignDefined(out, "head_sha", pickStr(rec, "head_sha"));
  assignDefined(out, "head_branch", pickStr(rec, "head_branch"));
  assignDefined(out, "latest_check_runs_count", pickNum(rec, "latest_check_runs_count"));
  return Object.keys(out).length ? out : undefined;
}

function slimWorkflowPull(value: JsonValue): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "number", pickNum(rec, "number"));
  const head = asRecord(rec.head);
  if (head) {
    const slimHead: Record<string, JsonValue> = {};
    assignDefined(slimHead, "ref", pickStr(head, "ref"));
    assignDefined(slimHead, "sha", pickStr(head, "sha"));
    if (Object.keys(slimHead).length) out.head = slimHead;
  }
  return Object.keys(out).length ? out : undefined;
}

function slimWorkflowRun(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "id", pickNum(rec, "id"));
  assignDefined(out, "name", pickStr(rec, "name"));
  assignDefined(out, "display_title", pickStr(rec, "display_title"));
  assignDefined(out, "status", pickStr(rec, "status"));
  assignDefined(out, "conclusion", pickStr(rec, "conclusion"));
  assignDefined(out, "html_url", pickStr(rec, "html_url"));
  assignDefined(out, "event", pickStr(rec, "event"));
  assignDefined(out, "head_sha", pickStr(rec, "head_sha"));
  assignDefined(out, "head_branch", pickStr(rec, "head_branch"));
  assignDefined(out, "path", pickStr(rec, "path"));
  assignDefined(out, "run_attempt", pickNum(rec, "run_attempt"));
  assignDefined(out, "run_number", pickNum(rec, "run_number"));
  if (Array.isArray(rec.pull_requests)) {
    const pulls = rec.pull_requests.map(slimWorkflowPull).filter((row): row is JsonValue => row !== undefined);
    if (pulls.length) out.pull_requests = pulls;
  }
  return Object.keys(out).length ? out : undefined;
}

function slimWorkflowJob(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "id", pickNum(rec, "id"));
  assignDefined(out, "name", pickStr(rec, "name"));
  assignDefined(out, "status", pickStr(rec, "status"));
  assignDefined(out, "conclusion", pickStr(rec, "conclusion"));
  assignDefined(out, "html_url", pickStr(rec, "html_url"));
  assignDefined(out, "started_at", pickStr(rec, "started_at"));
  assignDefined(out, "completed_at", pickStr(rec, "completed_at"));
  assignDefined(out, "head_sha", pickStr(rec, "head_sha"));
  assignDefined(out, "workflow_name", pickStr(rec, "workflow_name"));
  assignDefined(out, "run_id", pickNum(rec, "run_id"));
  assignDefined(out, "run_attempt", pickNum(rec, "run_attempt"));
  return Object.keys(out).length ? out : undefined;
}

function slimReview(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "id", pickNum(rec, "id"));
  assignDefined(out, "state", pickStr(rec, "state"));
  assignDefined(out, "html_url", pickStr(rec, "html_url"));
  assignDefined(out, "user", slimActor(rec.user));
  return Object.keys(out).length ? out : undefined;
}

function slimComment(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "id", pickNum(rec, "id"));
  assignDefined(out, "html_url", pickStr(rec, "html_url"));
  assignDefined(out, "user", slimActor(rec.user));
  const body = pickStr(rec, "body");
  if (body) out.body = body.length > 500 ? `${body.slice(0, 500)}…` : body;
  return Object.keys(out).length ? out : undefined;
}

function slimCommit(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "id", pickStr(rec, "id"));
  assignDefined(out, "message", pickStr(rec, "message"));
  assignDefined(out, "timestamp", pickStr(rec, "timestamp"));
  const author = asRecord(rec.author);
  if (author) {
    const slimAuthor: Record<string, JsonValue> = {};
    assignDefined(slimAuthor, "name", pickStr(author, "name"));
    assignDefined(slimAuthor, "username", pickStr(author, "username"));
    if (Object.keys(slimAuthor).length) out.author = slimAuthor;
  }
  return Object.keys(out).length ? out : undefined;
}

function slimGithubPayload(root: Record<string, JsonValue>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "action", pickStr(root, "action"));
  assignDefined(out, "ref", pickStr(root, "ref"));
  assignDefined(out, "after", pickStr(root, "after"));
  assignDefined(out, "before", pickStr(root, "before"));
  assignDefined(out, "master_branch", pickStr(root, "master_branch"));
  assignDefined(out, "state", pickStr(root, "state"));
  assignDefined(out, "sha", pickStr(root, "sha"));
  assignDefined(out, "context", pickStr(root, "context"));
  const description = pickStr(root, "description");
  if (description) out.description = description.length > 500 ? `${description.slice(0, 500)}…` : description;
  assignDefined(out, "target_url", pickStr(root, "target_url"));
  assignDefined(out, "created", pickBool(root, "created"));
  assignDefined(out, "deleted", pickBool(root, "deleted"));
  assignDefined(out, "forced", pickBool(root, "forced"));
  assignDefined(out, "number", pickNum(root, "number"));
  assignDefined(out, "zen", pickStr(root, "zen"));
  assignDefined(out, "hook_id", pickNum(root, "hook_id"));
  assignDefined(out, "repository", slimRepo(root.repository));
  assignDefined(out, "head_repository", slimRepo(root.head_repository));
  assignDefined(out, "sender", slimActor(root.sender));
  assignDefined(out, "organization", slimActor(root.organization));
  assignDefined(out, "pusher", slimPusher(root.pusher));
  assignDefined(out, "pull_request", slimPullRequest(root.pull_request));
  assignDefined(out, "issue", slimIssue(root.issue));
  assignDefined(out, "check_run", slimCheckRun(root.check_run));
  assignDefined(out, "check_suite", slimCheckSuite(root.check_suite));
  assignDefined(out, "workflow_run", slimWorkflowRun(root.workflow_run));
  assignDefined(out, "workflow_job", slimWorkflowJob(root.workflow_job));
  assignDefined(out, "review", slimReview(root.review));
  assignDefined(out, "comment", slimComment(root.comment));
  assignDefined(out, "head_commit", slimCommit(root.head_commit));
  if (Array.isArray(root.commits)) {
    const commits = root.commits.slice(0, 5).map(slimCommit).filter((row): row is JsonValue => row !== undefined);
    if (commits.length) out.commits = commits;
    if (root.commits.length > 5) out.commits_omitted = root.commits.length - 5;
  }
  const installation = asRecord(root.installation);
  const installationId = pickNum(installation, "id");
  if (installationId !== undefined) out.installation = { id: installationId };
  return out;
}

function slimSentryProject(value: JsonValue | undefined): JsonValue | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "id", pickStr(rec, "id") ?? (pickNum(rec, "id") !== undefined ? String(rec.id) : undefined));
  assignDefined(out, "name", pickStr(rec, "name"));
  assignDefined(out, "slug", pickStr(rec, "slug"));
  assignDefined(out, "platform", pickStr(rec, "platform"));
  return Object.keys(out).length ? out : undefined;
}

function slimSentryActor(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "type", pickStr(rec, "type"));
  assignDefined(out, "id", pickStr(rec, "id") ?? (pickNum(rec, "id") !== undefined ? String(rec.id) : undefined));
  assignDefined(out, "name", pickStr(rec, "name"));
  assignDefined(out, "email", pickStr(rec, "email"));
  return Object.keys(out).length ? out : undefined;
}

function slimSentryIssue(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "id", pickStr(rec, "id") ?? (pickNum(rec, "id") !== undefined ? String(rec.id) : undefined));
  assignDefined(out, "shortId", pickStr(rec, "shortId"));
  assignDefined(out, "title", pickStr(rec, "title"));
  assignDefined(out, "culprit", pickStr(rec, "culprit"));
  assignDefined(out, "level", pickStr(rec, "level"));
  assignDefined(out, "status", pickStr(rec, "status"));
  assignDefined(out, "substatus", pickStr(rec, "substatus"));
  assignDefined(out, "project", slimSentryProject(rec.project));
  assignDefined(out, "permalink", pickStr(rec, "permalink") ?? pickStr(rec, "web_url") ?? pickStr(rec, "url"));
  assignDefined(out, "count", pickStr(rec, "count") ?? (pickNum(rec, "count") !== undefined ? String(rec.count) : undefined));
  assignDefined(out, "userCount", pickNum(rec, "userCount"));
  assignDefined(out, "firstSeen", pickStr(rec, "firstSeen"));
  assignDefined(out, "lastSeen", pickStr(rec, "lastSeen"));
  assignDefined(out, "priority", pickStr(rec, "priority"));
  assignDefined(out, "seerFixabilityScore", pickNum(rec, "seerFixabilityScore"));
  // Assignment deliveries live or die by the new owner surviving the slim.
  assignDefined(out, "assignedTo", slimSentryActor(rec.assignedTo));
  return Object.keys(out).length ? out : undefined;
}

function slimSentryException(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "type", pickStr(rec, "type"));
  assignDefined(out, "value", pickStr(rec, "value"));
  assignDefined(out, "module", pickStr(rec, "module"));
  const stacktrace = asRecord(rec.stacktrace);
  if (stacktrace && Array.isArray(stacktrace.frames)) {
    const frames = stacktrace.frames.slice(-2).map((f) => {
      const fr = asRecord(f);
      if (!fr) return undefined;
      const sf: Record<string, JsonValue> = {};
      assignDefined(sf, "filename", pickStr(fr, "filename"));
      assignDefined(sf, "function", pickStr(fr, "function"));
      assignDefined(sf, "lineno", pickNum(fr, "lineno"));
      assignDefined(sf, "colno", pickNum(fr, "colno"));
      assignDefined(sf, "context_line", pickStr(fr, "context_line")?.trim());
      return Object.keys(sf).length ? sf : undefined;
    }).filter((f): f is Record<string, JsonValue> => f !== undefined);
    if (frames.length) out.frames = frames;
  }
  return Object.keys(out).length ? out : undefined;
}

function slimSentryEvent(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "id", pickStr(rec, "id") ?? pickStr(rec, "event_id"));
  assignDefined(out, "title", pickStr(rec, "title") ?? pickStr(rec, "message"));
  assignDefined(out, "level", pickStr(rec, "level"));
  assignDefined(out, "culprit", pickStr(rec, "culprit"));
  assignDefined(out, "release", pickStr(rec, "release"));
  assignDefined(out, "environment", pickStr(rec, "environment"));
  assignDefined(out, "timestamp", pickStr(rec, "timestamp") ?? pickStr(rec, "datetime"));
  assignDefined(out, "project", slimSentryProject(rec.project));

  const exc = asRecord(rec.exception) ?? (Array.isArray(rec.entries) ? asRecord(asRecord(rec.entries.find((e) => asRecord(e)?.type === "exception"))?.data) : undefined);
  if (exc) {
    const values = Array.isArray(exc.values) ? exc.values : [exc];
    // Keep the tail of chained exceptions so the newest failure (which surfaced the event) survives slimming.
    const slimExc = values.slice(-2).map(slimSentryException).filter((e): e is JsonValue => e !== undefined);
    if (slimExc.length) out.exceptions = slimExc;
  }
  return Object.keys(out).length ? out : undefined;
}

function isSentryUrl(val: unknown): boolean {
  if (typeof val !== "string" || !val) return false;
  try {
    const parsed = new URL(val);
    return parsed.hostname === "sentry.io" || parsed.hostname.endsWith(".sentry.io");
  } catch {
    return false;
  }
}

export function isSentryWebhookPayload(payload: JsonValue): boolean {
  const root = asRecord(payload);
  if (!root) return false;
  if (root.actor) {
    const act = asRecord(root.actor);
    if (act?.name === "Sentry" || act?.id === "sentry") return true;
  }
  if (root.installation && pickStr(asRecord(root.installation), "uuid")) {
    if (root.action !== undefined || root.data !== undefined) return true;
  }
  const data = asRecord(root.data) ?? root;
  const issue = asRecord(data.issue);
  const event = asRecord(data.event);
  // culprit and shortId are not Sentry-exclusive — generic issue trackers carry
  // them — so only validated Sentry URLs, actor, or installation mark the payload.
  if (
    issue &&
    (isSentryUrl(issue.permalink) || isSentryUrl(issue.url))
  ) {
    return true;
  }
  if (
    event &&
    (isSentryUrl(event.url) || isSentryUrl(event.web_url) || isSentryUrl(event.permalink))
  ) {
    return true;
  }
  return false;
}

export function slimSentryPayload(payload: JsonValue): JsonValue {
  const root = asRecord(payload);
  if (!root) return payload;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "action", pickStr(root, "action"));
  const data = asRecord(root.data);
  const issue = slimSentryIssue(data?.issue ?? root.issue);
  const event = slimSentryEvent(data?.event ?? root.event);
  if (issue) out.issue = issue;
  if (event) out.event = event;
  assignDefined(out, "actor", slimSentryActor(root.actor));
  const installation = asRecord(root.installation);
  if (installation) {
    const uuid = pickStr(installation, "uuid");
    if (uuid) out.installation = { uuid };
  }

  // Preserve non-issue/non-event Sentry payload data (e.g. metric_alert,
  // comment), hoisted to the root like issue/event.  Keep ONE copy:  a
  // duplicate under out.data doubled large alerts past MAX_EVENT_CHARS and
  // the serializer sliced them into invalid JSON.
  if (data) {
    for (const [key, val] of Object.entries(data)) {
      if (key === "issue" || key === "event") continue;
      out[key] = val;
    }
  }

  // Also preserve any custom or non-standard top-level resources
  for (const [key, val] of Object.entries(root)) {
    if (
      key === "action" ||
      key === "actor" ||
      key === "installation" ||
      key === "data" ||
      key === "issue" ||
      key === "event"
    ) {
      continue;
    }
    if (out[key] === undefined) {
      out[key] = val;
    }
  }

  return Object.keys(out).length ? out : payload;
}

function slimPagerDutyUser(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "id", pickStr(rec, "id"));
  assignDefined(out, "summary", pickStr(rec, "summary") ?? pickStr(rec, "name"));
  assignDefined(out, "name", pickStr(rec, "name") ?? pickStr(rec, "summary"));
  assignDefined(out, "type", pickStr(rec, "type"));
  return Object.keys(out).length ? out : undefined;
}

function slimPagerDutyIncident(value: JsonValue | undefined): JsonValue | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const out: Record<string, JsonValue> = {};
  assignDefined(out, "id", pickStr(rec, "id"));
  assignDefined(out, "incident_number", pickNum(rec, "incident_number") ?? pickNum(rec, "number"));
  assignDefined(out, "title", pickStr(rec, "title") ?? pickStr(rec, "summary"));
  assignDefined(out, "status", pickStr(rec, "status"));
  assignDefined(out, "urgency", pickStr(rec, "urgency"));
  assignDefined(out, "html_url", pickStr(rec, "html_url"));
  assignDefined(out, "created_at", pickStr(rec, "created_at") ?? pickStr(rec, "created_on"));
  assignDefined(out, "created_on", pickStr(rec, "created_on") ?? pickStr(rec, "created_at"));
  const priorityRec = asRecord(rec.priority);
  if (priorityRec) {
    const pOut: Record<string, JsonValue> = {};
    assignDefined(pOut, "id", pickStr(priorityRec, "id"));
    assignDefined(pOut, "summary", pickStr(priorityRec, "summary") ?? pickStr(priorityRec, "name"));
    if (Object.keys(pOut).length) out.priority = pOut;
  } else if (typeof rec.priority === "string" && rec.priority.trim()) {
    out.priority = { summary: rec.priority.trim() };
  }
  const service = asRecord(rec.service);
  if (service) {
    const sOut: Record<string, JsonValue> = {};
    assignDefined(sOut, "id", pickStr(service, "id"));
    assignDefined(sOut, "name", pickStr(service, "name") ?? pickStr(service, "summary"));
    if (Object.keys(sOut).length) out.service = sOut;
  }
  if (Array.isArray(rec.assignments)) {
    const slimAssignments = rec.assignments
      .slice(0, 5)
      .map((a) => {
        const aRec = asRecord(a);
        if (!aRec) return undefined;
        const aOut: Record<string, JsonValue> = {};
        assignDefined(aOut, "at", pickStr(aRec, "at"));
        const user = slimPagerDutyUser(aRec.assignee) ?? slimPagerDutyUser(aRec);
        if (user) {
          if (asRecord(aRec.assignee)) {
            aOut.assignee = user;
          } else {
            Object.assign(aOut, user);
          }
        }
        return Object.keys(aOut).length ? aOut : undefined;
      })
      .filter((a): a is Record<string, JsonValue> => Boolean(a));
    if (slimAssignments.length) out.assignments = slimAssignments;
  }
  if (Array.isArray(rec.assignees)) {
    const slimAssignees = rec.assignees
      .slice(0, 5)
      .map((a) => slimPagerDutyUser(a))
      .filter((a): a is Record<string, JsonValue> => Boolean(a));
    if (slimAssignees.length) out.assignees = slimAssignees;
  }
  if (rec.assignee) {
    const user = slimPagerDutyUser(rec.assignee);
    if (user) out.assignee = user;
  }
  return Object.keys(out).length ? out : undefined;
}

function isPagerDutyUrl(val: unknown): boolean {
  if (typeof val !== "string" || !val) return false;
  try {
    const parsed = new URL(val);
    return parsed.hostname === "pagerduty.com" || parsed.hostname.endsWith(".pagerduty.com");
  } catch {
    return false;
  }
}

export function isPagerDutyWebhookPayload(payload: JsonValue): boolean {
  const root = asRecord(payload);
  if (!root) return false;
  const event = asRecord(root.event);
  if (event) {
    const data = asRecord(event.data);
    const htmlUrl = pickStr(data, "html_url") ?? pickStr(event, "html_url") ?? pickStr(data, "self") ?? pickStr(event, "self");
    if (isPagerDutyUrl(htmlUrl)) return true;
    const eventType = pickStr(event, "event_type");
    if (eventType?.startsWith("incident.")) {
      const resourceType = pickStr(event, "resource_type");
      const dataType = pickStr(data, "type");
      const hasResourceType =
        resourceType === "incident" ||
        dataType === "incident" ||
        dataType === "incident_reference";
      const hasExpectedEnvelope = Boolean(
        event.agent !== undefined ||
        event.client !== undefined ||
        (data && (
          data.urgency !== undefined ||
          data.status !== undefined ||
          data.service !== undefined ||
          data.assignments !== undefined ||
          data.assignees !== undefined ||
          data.priority !== undefined
        ))
      );
      if (hasResourceType && hasExpectedEnvelope) return true;
      if (data && (isPagerDutyUrl(data.self) || isPagerDutyUrl(pickStr(asRecord(data.service), "html_url")))) return true;
    }
  }
  if (Array.isArray(root.messages) && root.messages.length > 0) {
    return root.messages.some((msg) => {
      const rec = asRecord(msg);
      if (!rec) return false;
      const eventName = pickStr(rec, "event") ?? pickStr(rec, "type");
      const inc = asRecord(rec.incident);
      if (!inc) return false;
      if (
        isPagerDutyUrl(inc.html_url) ||
        isPagerDutyUrl(inc.url) ||
        isPagerDutyUrl(pickStr(asRecord(inc.service), "html_url"))
      ) {
        return true;
      }
      if (eventName?.startsWith("incident.")) {
        const hasLegacyMarker = Boolean(
          inc.status !== undefined ||
          inc.urgency !== undefined ||
          inc.service !== undefined ||
          inc.incident_number !== undefined ||
          inc.incident_key !== undefined ||
          rec.created_on !== undefined ||
          inc.created_on !== undefined
        );
        if (hasLegacyMarker) return true;
      }
      return false;
    });
  }
  return false;
}

export function slimPagerDutyPayload(payload: JsonValue): JsonValue {
  const root = asRecord(payload);
  if (!root) return payload;
  const out: Record<string, JsonValue> = {};
  const event = asRecord(root.event);
  if (event) {
    assignDefined(out, "event_type", pickStr(event, "event_type"));
    assignDefined(out, "occurred_at", pickStr(event, "occurred_at"));
    const agent = slimPagerDutyUser(event.agent);
    if (agent) out.agent = agent;
    const data = asRecord(event.data);
    const incident = slimPagerDutyIncident(data ?? event);
    if (incident) out.incident = incident;
  } else if (Array.isArray(root.messages)) {
    const rawMessages = root.messages.slice(0, 10);
    const slimmedMessages: Record<string, JsonValue>[] = [];
    for (const rawMsg of rawMessages) {
      const msgRec = asRecord(rawMsg);
      if (!msgRec) continue;
      const sMsg: Record<string, JsonValue> = {};
      assignDefined(sMsg, "event", pickStr(msgRec, "event") ?? pickStr(msgRec, "type"));
      assignDefined(sMsg, "id", pickStr(msgRec, "id"));
      assignDefined(sMsg, "created_on", pickStr(msgRec, "created_on") ?? pickStr(msgRec, "created_at"));
      const agent = slimPagerDutyUser(msgRec.agent);
      if (agent) sMsg.agent = agent;
      const inc = slimPagerDutyIncident(msgRec.incident);
      if (inc) sMsg.incident = inc;
      if (Object.keys(sMsg).length) slimmedMessages.push(sMsg);
    }
    if (slimmedMessages.length > 0) {
      out.messages = slimmedMessages;
      const first = slimmedMessages[0];
      assignDefined(out, "event_type", pickStr(first, "event"));
      assignDefined(out, "created_on", pickStr(first, "created_on"));
      if (first.agent) out.agent = first.agent;
    }
    if (root.messages.length > rawMessages.length) {
      out.omitted_messages = root.messages.length - rawMessages.length;
    }
  }

  // Preserve any custom top-level fields
  for (const [key, val] of Object.entries(root)) {
    if (key === "event" || key === "messages") continue;
    if (out[key] === undefined) out[key] = val;
  }

  return Object.keys(out).length ? out : payload;
}

export function isGithubWebhookPayload(payload: JsonValue): boolean {
  const root = asRecord(payload);
  if (!root) return false;
  return Boolean(slimRepo(root.repository) || slimRepo(root.head_repository));
}

/** Drop GitHub, Sentry, and PagerDuty URL farms and log blobs. Other JSON is unchanged. */
export function slimWebhookPayload(payload: JsonValue): JsonValue {
  const root = asRecord(payload);
  if (!root) return payload;
  if (isGithubWebhookPayload(root)) return slimGithubPayload(root);
  if (isPagerDutyWebhookPayload(root)) return slimPagerDutyPayload(root);
  if (isSentryWebhookPayload(root)) return slimSentryPayload(root);
  return payload;
}

export function serializeWebhookPayload(payload: JsonValue): string {
  let text: string;
  const plainText = z.string().safeParse(payload);
  if (plainText.success) text = plainText.data;
  else {
    const slimmed = slimWebhookPayload(payload);
    try {
      text = JSON.stringify(slimmed) ?? String(slimmed);
    } catch {
      text = String(slimmed);
    }
  }
  if (text.length <= MAX_EVENT_CHARS) return text;
  return `${text.slice(0, MAX_EVENT_CHARS)}\n\n[Payload truncated by BotFleet]`;
}
