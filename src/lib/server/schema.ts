import {
  sqliteTable,
  blob,
  text,
  integer,
  real,
  index,
  primaryKey,
} from "drizzle-orm/sqlite-core";
import type { Document } from "../types";

export const taskBoards = sqliteTable("task_boards", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  archivedAt: integer("archived_at"),
  revision: integer("revision").notNull().default(1),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    completedAt: integer("completed_at"),
    boardId: text("board_id").references(() => taskBoards.id, {
      onDelete: "set null",
    }),
    openStage: text("open_stage")
      .$type<"todo" | "in_progress">()
      .notNull()
      .default("todo"),
    boardPosition: real("board_position").notNull().default(0),
    trashedAt: integer("trashed_at"),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    dueDate: text("due_date"),
    plannedDate: text("planned_date"),
    recurrence: text("recurrence").$type<import("../dates").Recurrence>(),
    recurrenceDay: integer("recurrence_day"),
    parentTaskId: text("parent_task_id"),
    noteId: text("note_id").references(() => notes.id, {
      onDelete: "set null",
    }),
  },
  (t) => [index("tasks_owner_created_idx").on(t.ownerId, t.createdAt)],
);

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" })
    .notNull()
    .default(false),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  username: text("username").notNull().unique(),
  displayUsername: text("display_username"),
  twoFactorEnabled: integer("two_factor_enabled", { mode: "boolean" })
    .notNull()
    .default(false),
});
export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);
export const passkey = sqliteTable(
  "passkey",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    publicKey: text("public_key").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    credentialID: text("credential_id").notNull().unique(),
    counter: integer("counter").notNull(),
    deviceType: text("device_type").notNull(),
    backedUp: integer("backed_up", { mode: "boolean" }).notNull(),
    transports: text("transports"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }),
    aaguid: text("aaguid"),
  },
  (t) => [index("passkey_user_idx").on(t.userId)],
);
export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", {
    mode: "timestamp_ms",
  }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", {
    mode: "timestamp_ms",
  }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
export const notes = sqliteTable(
  "notes",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id),
    title: text("title").notNull().default(""),
    document: text("document", { mode: "json" }).$type<Document>().notNull(),
    kind: text("kind").$type<"note">().notNull().default("note"),
    dailyDate: text("daily_date"),
    editorWidth: text("editor_width")
      .$type<"standard" | "wide">()
      .notNull()
      .default("standard"),
    text: text("text").notNull().default(""),
    revision: integer("revision").notNull().default(1),
    favorite: integer("favorite", { mode: "boolean" }).notNull().default(false),
    trashedAt: integer("trashed_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("notes_updated_idx").on(t.updatedAt)],
);
export const tags = sqliteTable("tags", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  color: text("color").notNull().default("gray"),
  aliases: text("aliases", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default([]),
});
export const noteTags = sqliteTable(
  "note_tags",
  {
    noteId: text("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.noteId, t.tagId] }),
    index("note_tags_tag_idx").on(t.tagId, t.noteId),
  ],
);
export const attachments = sqliteTable("attachments", {
  id: text("id").primaryKey(),
  noteId: text("note_id")
    .notNull()
    .references(() => notes.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  mime: text("mime").notNull(),
  size: integer("size").notNull(),
  storageKey: text("storage_key").notNull().unique(),
  createdAt: integer("created_at").notNull(),
});
export const instance = sqliteTable("instance", {
  id: integer("id").primaryKey(),
  recoveryHash: text("recovery_hash"),
  theme: text("theme").notNull().default("system"),
  uploadLimit: integer("upload_limit").notNull().default(26214400),
  onboardingStep: text("onboarding_step")
    .$type<"tags" | "install" | "complete">()
    .notNull()
    .default("complete"),
});

export const publications = sqliteTable("publications", {
  token: text("token").primaryKey(),
  noteId: text("note_id")
    .notNull()
    .unique()
    .references(() => notes.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  document: text("document", { mode: "json" }).$type<Document>().notNull(),
  excerpt: text("excerpt").notNull(),
  revision: integer("revision").notNull(),
  publishedAt: integer("published_at").notNull(),
});
export const publicationFiles = sqliteTable(
  "publication_files",
  {
    id: text("id").primaryKey(),
    token: text("token")
      .notNull()
      .references(() => publications.token, { onDelete: "cascade" }),
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    storageKey: text("storage_key").notNull().unique(),
  },
  (t) => [index("publication_files_token_idx").on(t.token)],
);

export const twoFactor = sqliteTable(
  "two_factor",
  {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    verified: integer("verified", { mode: "boolean" }).default(true),
    failedVerificationCount: integer("failed_verification_count").default(0),
    lockedUntil: integer("locked_until", { mode: "timestamp_ms" }),
  },
  (t) => [
    index("two_factor_user_idx").on(t.userId),
    index("two_factor_secret_idx").on(t.secret),
  ],
);

export const bookmarks = sqliteTable("bookmarks", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  noteId: text("note_id").references(() => notes.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  siteName: text("site_name").notNull().default(""),
  collection: text("collection").notNull().default(""),
  favorite: integer("favorite", { mode: "boolean" }).notNull().default(false),
  titleEdited: integer("title_edited").notNull().default(0),
  descriptionEdited: integer("description_edited").notNull().default(0),
  metadataStatus: text("metadata_status").notNull().default("unavailable"),
  thumbnailKey: text("thumbnail_key"),
  thumbnailMime: text("thumbnail_mime"),
  iconKey: text("icon_key"),
  iconMime: text("icon_mime"),
  trashedAt: integer("trashed_at"),
  revision: integer("revision").notNull().default(1),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const noteVersions = sqliteTable(
  "note_versions",
  {
    id: text("id").primaryKey(),
    noteId: text("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    document: text("document", { mode: "json" }).$type<Document>().notNull(),
    revision: integer("revision").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("note_versions_note_idx").on(t.noteId, t.createdAt)],
);
export const noteLinks = sqliteTable(
  "note_links",
  {
    sourceId: text("source_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    targetId: text("target_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.sourceId, t.targetId] }),
    index("note_links_target_idx").on(t.targetId),
  ],
);

export const backgroundJobs = sqliteTable("background_jobs", {
  generation: integer("generation"),
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  kind: text("kind")
    .$type<"artifact" | "bookmark" | "thumbnail" | "semantic">()
    .notNull(),
  targetId: text("target_id").notNull(),
  state: text("state")
    .$type<"queued" | "running" | "done" | "failed">()
    .notNull()
    .default("queued"),
  attempts: integer("attempts").notNull().default(0),
  availableAt: integer("available_at").notNull(),
  leaseUntil: integer("lease_until"),
  leaseToken: text("lease_token"),
  createdAt: integer("created_at").notNull(),
});
export const completionEvents = sqliteTable("completion_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ownerId: text("owner_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  kind: text("kind")
    .$type<"artifact" | "bookmark" | "backup" | "content" | "ai">()
    .notNull(),
  targetId: text("target_id").notNull(),
  status: text("status").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const taskTags = sqliteTable(
  "task_tags",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.tagId] }),
    index("task_tags_tag_idx").on(t.tagId, t.taskId),
  ],
);
export const bookmarkTags = sqliteTable(
  "bookmark_tags",
  {
    bookmarkId: text("bookmark_id")
      .notNull()
      .references(() => bookmarks.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.bookmarkId, t.tagId] }),
    index("bookmark_tags_tag_idx").on(t.tagId, t.bookmarkId),
  ],
);
export const artifacts = sqliteTable("artifacts", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  kind: text("kind").$type<"text" | "image" | "file">().notNull(),
  title: text("title").notNull().default(""),
  content: text("content").notNull().default(""),
  name: text("name").notNull().default(""),
  mime: text("mime").notNull().default(""),
  size: integer("size").notNull().default(0),
  width: integer("width").notNull().default(0),
  height: integer("height").notNull().default(0),
  storageKey: text("storage_key"),
  thumbKey: text("thumb_key"),
  extraction: text("extraction").notNull().default("none"),
  revision: integer("revision").notNull().default(1),
  trashedAt: integer("trashed_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
export const artifactTags = sqliteTable(
  "artifact_tags",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.artifactId, t.tagId] }),
    index("artifact_tags_tag_idx").on(t.tagId, t.artifactId),
  ],
);

export const oauthClient = sqliteTable("oauth_client", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull().unique(),
  clientSecret: text("client_secret"),
  clientDiscoveryId: text("client_discovery_id"),
  disabled: integer("disabled", { mode: "boolean" }).default(false),
  skipConsent: integer("skip_consent", { mode: "boolean" }),
  enableEndSession: integer("enable_end_session", { mode: "boolean" }),
  subjectType: text("subject_type"),
  scopes: text("scopes", { mode: "json" }).$type<string[]>(),
  clientCredentialsScopes: text("client_credentials_scopes", { mode: "json" })
    .$type<string[]>()
    .default([]),
  userId: text("user_id").references(() => user.id),
  createdAt: integer("created_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
  name: text("name"),
  uri: text("uri"),
  icon: text("icon"),
  contacts: text("contacts", { mode: "json" }).$type<string[]>(),
  tos: text("tos"),
  policy: text("policy"),
  softwareId: text("software_id"),
  softwareVersion: text("software_version"),
  softwareStatement: text("software_statement"),
  redirectUris: text("redirect_uris", { mode: "json" })
    .$type<string[]>()
    .notNull(),
  postLogoutRedirectUris: text("post_logout_redirect_uris", {
    mode: "json",
  }).$type<string[]>(),
  backchannelLogoutUri: text("backchannel_logout_uri"),
  backchannelLogoutSessionRequired: integer(
    "backchannel_logout_session_required",
    { mode: "boolean" },
  ),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
  applicationType: text("application_type"),
  jwks: text("jwks"),
  jwksUri: text("jwks_uri"),
  grantTypes: text("grant_types", { mode: "json" }).$type<string[]>(),
  responseTypes: text("response_types", { mode: "json" }).$type<string[]>(),
  requirePKCE: integer("require_p_k_c_e", { mode: "boolean" }),
  dpopBoundAccessTokens: integer("dpop_bound_access_tokens", {
    mode: "boolean",
  }).default(false),
  referenceId: text("reference_id"),
  metadata: text("metadata", { mode: "json" }),
});
export const oauthResource = sqliteTable("oauth_resource", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull().unique(),
  name: text("name").notNull(),
  accessTokenTtl: integer("access_token_ttl"),
  refreshTokenTtl: integer("refresh_token_ttl"),
  signingAlgorithm: text("signing_algorithm"),
  signingKeyId: text("signing_key_id"),
  allowedScopes: text("allowed_scopes", { mode: "json" }).$type<string[]>(),
  customClaims: text("custom_claims", { mode: "json" }),
  dpopBoundAccessTokensRequired: integer("dpop_bound_access_tokens_required", {
    mode: "boolean",
  }).default(false),
  disabled: integer("disabled", { mode: "boolean" }).default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
  policyVersion: integer("policy_version").default(1),
  metadata: text("metadata", { mode: "json" }),
});
export const oauthClientResource = sqliteTable("oauth_client_resource", {
  id: text("id").primaryKey(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClient.clientId, { onDelete: "cascade" }),
  resourceId: text("resource_id")
    .notNull()
    .references(() => oauthResource.identifier, { onDelete: "cascade" }),
  metadata: text("metadata", { mode: "json" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }),
});
export const oauthRefreshToken = sqliteTable("oauth_refresh_token", {
  id: text("id").primaryKey(),
  token: text("token").notNull().unique(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClient.clientId),
  sessionId: text("session_id").references(() => session.id, {
    onDelete: "set null",
  }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id),
  referenceId: text("reference_id"),
  authorizationCodeId: text("authorization_code_id"),
  resources: text("resources", { mode: "json" }).$type<string[]>(),
  requestedUserInfoClaims: text("requested_user_info_claims", {
    mode: "json",
  }).$type<string[]>(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }),
  revoked: integer("revoked", { mode: "timestamp_ms" }),
  rotatedAt: integer("rotated_at", { mode: "timestamp_ms" }),
  rotationReplayResponse: text("rotation_replay_response"),
  rotationReplayExpiresAt: integer("rotation_replay_expires_at", {
    mode: "timestamp_ms",
  }),
  authTime: integer("auth_time", { mode: "timestamp_ms" }),
  confirmation: text("confirmation", { mode: "json" }),
  scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
});
export const oauthAccessToken = sqliteTable("oauth_access_token", {
  id: text("id").primaryKey(),
  token: text("token").unique(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClient.clientId),
  sessionId: text("session_id").references(() => session.id, {
    onDelete: "set null",
  }),
  userId: text("user_id").references(() => user.id),
  referenceId: text("reference_id"),
  authorizationCodeId: text("authorization_code_id"),
  resources: text("resources", { mode: "json" }).$type<string[]>(),
  requestedUserInfoClaims: text("requested_user_info_claims", {
    mode: "json",
  }).$type<string[]>(),
  refreshId: text("refresh_id").references(() => oauthRefreshToken.id),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }),
  revoked: integer("revoked", { mode: "timestamp_ms" }),
  confirmation: text("confirmation", { mode: "json" }),
  scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
});
export const oauthConsent = sqliteTable("oauth_consent", {
  id: text("id").primaryKey(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClient.clientId),
  userId: text("user_id").references(() => user.id),
  referenceId: text("reference_id"),
  resources: text("resources", { mode: "json" }).$type<string[]>(),
  requestedUserInfoClaims: text("requested_user_info_claims", {
    mode: "json",
  }).$type<string[]>(),
  scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
});
export const oauthClientAssertion = sqliteTable("oauth_client_assertion", {
  id: text("id").primaryKey(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
});
export const apikey = sqliteTable("apikey", {
  id: text("id").primaryKey(),
  configId: text("config_id").notNull().default("default"),
  name: text("name"),
  start: text("start"),
  referenceId: text("reference_id").notNull(),
  prefix: text("prefix"),
  key: text("key").notNull(),
  refillInterval: integer("refill_interval"),
  refillAmount: integer("refill_amount"),
  lastRefillAt: integer("last_refill_at", { mode: "timestamp_ms" }),
  enabled: integer("enabled", { mode: "boolean" }).default(true),
  rateLimitEnabled: integer("rate_limit_enabled", { mode: "boolean" }).default(
    true,
  ),
  rateLimitTimeWindow: integer("rate_limit_time_window").default(86400000),
  rateLimitMax: integer("rate_limit_max").default(10),
  requestCount: integer("request_count").default(0),
  remaining: integer("remaining"),
  lastRequest: integer("last_request", { mode: "timestamp_ms" }),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  permissions: text("permissions"),
  metadata: text("metadata"),
});
export const jwks = sqliteTable("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  alg: text("alg"),
  crv: text("crv"),
});

export const calendarEvents = sqliteTable("calendar_events", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
  recurring: integer("recurring", { mode: "boolean" }).notNull().default(false),
  data: text("data", { mode: "json" })
    .$type<import("../calendar").EventInput>()
    .notNull(),
  revision: integer("revision").notNull().default(1),
  trashedAt: integer("trashed_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const forms = sqliteTable("forms", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  title: text("title").notNull().default(""),
  description: text("description").notNull().default(""),
  definition: text("definition", { mode: "json" })
    .$type<import("../forms").FormDefinition>()
    .notNull(),
  status: text("status")
    .$type<"draft" | "published" | "closed">()
    .notNull()
    .default("draft"),
  publicToken: text("public_token"),
  publishedVersionId: text("published_version_id"),
  revision: integer("revision").notNull().default(1),
  favorite: integer("favorite", { mode: "boolean" }).notNull().default(false),
  uploadBudget: integer("upload_budget").notNull().default(262144000),
  closingDate: text("closing_date"),
  closingTimezone: text("closing_timezone"),
  closesAt: integer("closes_at"),
  trashedAt: integer("trashed_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
export const formVersions = sqliteTable("form_versions", {
  id: text("id").primaryKey(),
  formId: text("form_id")
    .notNull()
    .references(() => forms.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  definition: text("definition", { mode: "json" })
    .$type<import("../forms").FormDefinition>()
    .notNull(),
  createdAt: integer("created_at").notNull(),
});
export const formResponses = sqliteTable("form_responses", {
  id: text("id").primaryKey(),
  formId: text("form_id")
    .notNull()
    .references(() => forms.id, { onDelete: "cascade" }),
  versionId: text("version_id")
    .notNull()
    .references(() => formVersions.id),
  answers: text("answers", { mode: "json" })
    .$type<import("../forms").FormAnswers>()
    .notNull(),
  searchText: text("search_text").notNull().default(""),
  retryKey: text("retry_key").notNull(),
  requestHash: text("request_hash").notNull(),
  reviewed: integer("reviewed", { mode: "boolean" }).notNull().default(false),
  revision: integer("revision").notNull().default(1),
  trashedAt: integer("trashed_at"),
  createdAt: integer("created_at").notNull(),
});
export const formUploadSessions = sqliteTable("form_upload_sessions", {
  id: text("id").primaryKey(),
  formId: text("form_id")
    .notNull()
    .references(() => forms.id, { onDelete: "cascade" }),
  versionId: text("version_id")
    .notNull()
    .references(() => formVersions.id),
  secretHash: text("secret_hash").notNull(),
  expiresAt: integer("expires_at").notNull(),
});
export const formFiles = sqliteTable("form_files", {
  id: text("id").primaryKey(),
  formId: text("form_id")
    .notNull()
    .references(() => forms.id, { onDelete: "cascade" }),
  sessionId: text("session_id").references(() => formUploadSessions.id),
  responseId: text("response_id").references(() => formResponses.id),
  fieldId: text("field_id").notNull(),
  filename: text("filename").notNull(),
  mime: text("mime").notNull(),
  size: integer("size").notNull(),
  storageKey: text("storage_key").notNull(),
  thumbKey: text("thumb_key"),
  thumbnailStatus: text("thumbnail_status")
    .$type<"pending" | "done" | "none" | "failed">()
    .notNull()
    .default("none"),
  state: text("state")
    .$type<"reserved" | "writing" | "ready" | "attached" | "failed">()
    .notNull()
    .default("reserved"),
  createdAt: integer("created_at").notNull(),
});
export const formTags = sqliteTable("form_tags", {
  formId: text("form_id")
    .notNull()
    .references(() => forms.id, { onDelete: "cascade" }),
  tagId: text("tag_id")
    .notNull()
    .references(() => tags.id, { onDelete: "cascade" }),
});

export const aiConfiguration = sqliteTable("ai_configuration", {
  publicNextAt: integer("public_next_at").notNull().default(0),
  chunkCount: integer("chunk_count").notNull().default(0),
  id: integer("id").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  revision: integer("revision").notNull().default(1),
  taggingMode: text("tagging_mode")
    .$type<"manual" | "automatic">()
    .notNull()
    .default("manual"),
  learnedTagRevision: integer("learned_tag_revision").notNull().default(1),
  matcherQueueRevision: integer("matcher_queue_revision").notNull().default(1),
  vocabularyGeneration: integer("vocabulary_generation").notNull().default(1),
  indexGeneration: integer("index_generation").notNull().default(1),
});
export const aiContent = sqliteTable("ai_content", {
  pending: integer("pending", { mode: "boolean" }).notNull().default(true),
  sourceKey: text("source_key").primaryKey(),
  ownerId: text("owner_id").references(() => user.id, { onDelete: "cascade" }),
  itemKind: text("item_kind"),
  itemId: text("item_id"),
  vocabularyGeneration: integer("vocabulary_generation").notNull().default(0),
  generation: integer("generation").notNull().default(1),
  state: text("state").notNull().default("pending"),
  fingerprint: text("fingerprint"),
  modelVersion: text("model_version"),
  indexedGeneration: integer("indexed_generation"),
  retryAfter: integer("retry_after").notNull().default(0),
  failures: integer("failures").notNull().default(0),
});
export const aiChunks = sqliteTable(
  "ai_chunks",
  {
    sourceKey: text("source_key")
      .notNull()
      .references(() => aiContent.sourceKey, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    generation: integer("generation").notNull(),
    modelVersion: text("model_version").notNull(),
    title: text("title").notNull(),
    text: text("text").notNull(),
    dimensions: integer("dimensions").notNull().default(384),
    modality: text("modality").notNull().default("text"),
    embedding: blob("embedding", { mode: "buffer" }).notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.sourceKey, t.modelVersion, t.modality, t.ordinal],
    }),
  ],
);
export const aiSuggestions = sqliteTable("ai_suggestions", {
  sourceKey: text("source_key")
    .primaryKey()
    .references(() => aiContent.sourceKey, { onDelete: "cascade" }),
  id: text("id").notNull().unique(),
  generation: integer("generation").notNull(),
  fingerprint: text("fingerprint").notNull(),
  score: real("score").notNull(),
  modelVersion: text("model_version").notNull(),
  vocabularyGeneration: integer("vocabulary_generation").notNull(),
  tagId: text("tag_id")
    .notNull()
    .references(() => tags.id, { onDelete: "cascade" }),
  createdAt: integer("created_at").notNull(),
});
export const responseTags = sqliteTable(
  "response_tags",
  {
    responseId: text("response_id")
      .notNull()
      .references(() => formResponses.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.responseId, t.tagId] })],
);

export const aiDecisions = sqliteTable(
  "ai_decisions",
  {
    sourceKey: text("source_key")
      .notNull()
      .references(() => aiContent.sourceKey, { onDelete: "cascade" }),
    fingerprint: text("fingerprint").notNull(),
    tagId: text("tag_id").notNull(),
    tagFingerprint: text("tag_fingerprint").notNull(),
    proposalId: text("proposal_id").unique(),
    decision: text("decision").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [
        t.sourceKey,
        t.fingerprint,
        t.tagId,
        t.tagFingerprint,
        t.decision,
      ],
    }),
  ],
);
export const aiExtractions = sqliteTable("ai_extractions", {
  sourceKey: text("source_key")
    .primaryKey()
    .references(() => aiContent.sourceKey, { onDelete: "cascade" }),
  storageKey: text("storage_key").notNull(),
  text: text("text").notNull().default(""),
  status: text("status").notNull(),
});
