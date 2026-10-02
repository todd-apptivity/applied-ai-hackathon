/** Shapes returned by the Clio Manage API v4 read endpoints we use. */

export interface ClioTokens {
  accessToken: string;
  refreshToken: string;
  /** Unix epoch milliseconds. */
  expiresAt: number;
  tokenType: string;
  /** Unix epoch milliseconds the tokens were last written. */
  obtainedAt: number;
}

export interface ClioPaging {
  next?: string;
  previous?: string;
}

export interface ClioListResponse<T> {
  data: T[];
  meta?: {
    paging?: ClioPaging;
    records?: number;
  };
}

export interface ClioSingleResponse<T> {
  data: T;
}

export interface ClioRef {
  id: number;
  name?: string;
  type?: string;
  etag?: string;
}

export interface ClioUser extends ClioRef {
  first_name?: string;
  last_name?: string;
  email?: string;
  enabled?: boolean;
  account?: ClioRef;
}

export interface ClioPracticeArea extends ClioRef {
  code?: string;
}

export interface ClioMatterStage extends ClioRef {
  practice_area?: ClioRef;
}

export interface ClioContact extends ClioRef {
  type?: "Person" | "Company" | string;
  first_name?: string;
  last_name?: string;
  prefix?: string;
  title?: string;
  primary_email_address?: string;
  primary_phone_number?: string;
  primary_address?: Record<string, unknown>;
  email_addresses?: Array<{ name?: string; address?: string; default_email?: boolean }>;
  phone_numbers?: Array<{ name?: string; number?: string; default_number?: boolean }>;
  addresses?: Array<Record<string, unknown>>;
  created_at?: string;
  updated_at?: string;
}

export interface ClioCustomFieldValue {
  /** Composite string, e.g. "date-1702097093" — not the custom field's id. */
  id: string;
  field_type?: string;
  field_name?: string;
  value?: unknown;
  etag?: string;
}

export interface ClioMatter extends ClioRef {
  number?: string;
  display_number?: string;
  description?: string;
  status?: string;
  open_date?: string;
  close_date?: string;
  pending_date?: string;
  /** Clio returns the associated limitations Task, not a bare date. */
  statute_of_limitations?: Pick<ClioTask, "id" | "name" | "due_at" | "status">;
  client?: ClioContact;
  practice_area?: ClioPracticeArea;
  matter_stage?: ClioMatterStage;
  responsible_attorney?: ClioUser;
  originating_attorney?: ClioUser;
  custom_field_values?: ClioCustomFieldValue[];
  created_at?: string;
  updated_at?: string;
}

export interface ClioRelationship {
  id: number;
  description?: string;
  contact?: ClioContact;
  matter?: ClioRef;
  etag?: string;
}

export interface ClioNote extends ClioRef {
  subject?: string;
  detail?: string;
  date?: string;
  type?: string;
  matter?: ClioRef;
  created_at?: string;
  updated_at?: string;
}

export interface ClioCommunication extends ClioRef {
  subject?: string;
  body?: string;
  type?: "PhoneCommunication" | "EmailCommunication" | string;
  date?: string;
  received_at?: string;
  senders?: ClioRef[];
  receivers?: ClioRef[];
  matter?: ClioRef;
  created_at?: string;
  updated_at?: string;
}

export interface ClioTask extends ClioRef {
  description?: string;
  due_at?: string;
  status?: string;
  priority?: string;
  completed_at?: string;
  statute_of_limitations?: boolean;
  assignee?: ClioRef;
  matter?: ClioRef;
  created_at?: string;
  updated_at?: string;
}

export interface ClioCalendarEntry extends Omit<ClioRef, "id"> {
  /** Clio returns calendar entry ids as strings, unlike other resources. */
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start_at?: string;
  end_at?: string;
  all_day?: boolean;
  calendar_owner?: ClioRef;
  matter?: ClioRef;
  created_at?: string;
  updated_at?: string;
}

export interface ClioActivity extends ClioRef {
  type?: "TimeEntry" | "ExpenseEntry" | string;
  date?: string;
  quantity?: number;
  price?: number;
  total?: number;
  note?: string;
  activity_description?: ClioRef;
  matter?: ClioRef;
  created_at?: string;
  updated_at?: string;
}

export interface ClioDocument extends ClioRef {
  filename?: string;
  content_type?: string;
  size?: number;
  received_at?: string;
  document_category?: ClioRef;
  parent?: ClioRef;
  matter?: ClioRef;
  latest_document_version?: {
    id?: number;
    version_number?: number;
    received_at?: string;
    fully_uploaded?: boolean;
  };
  created_at?: string;
  updated_at?: string;
}

export interface ClioFolder extends ClioRef {
  parent?: ClioRef;
  matter?: ClioRef;
  created_at?: string;
  updated_at?: string;
}

export interface ClioCustomField extends ClioRef {
  parent_type?: string;
  field_type?: string;
  displayed?: boolean;
  deleted?: boolean;
  etag?: string;
}

export interface ClioCalendar extends ClioRef {
  type?: string;
}
