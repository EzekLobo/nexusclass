/** Shared wire types only. Provider code and credentials stay in server-only modules. */
export type AssistantAskInput = {
  question: string;
  request_id: string;
  include_slack?: boolean;
  group_id?: string;
  student_id?: string;
  lesson_id?: string;
  activity_id?: string;
  slack_conversation_ids?: string[];
};

export type AssistantSource = {
  source: "activity" | "slack";
  ref: string;
  label: string;
  href: string;
};

export type AssistantAnswer = {
  request_id: string;
  answer: string;
  insufficient_context: boolean;
  sources: AssistantSource[];
  limitations: string[];
};
