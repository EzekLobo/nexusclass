# Kodland Backoffice Endpoint Map

## Learn correction collection — public bundle inspection, 2026-11-17

Confirmed in `https://learn.kodland.org/_nuxt/fGvgONzy.js` and
`DS1Icf3d.js` (public code, no browser credentials):

- `GET /tasks/{taskId}/?group_id={groupId}`: task details; the check screen uses
  `id`, `unescaped_text_of_task`, `min_grade`, `max_grade`, `is_graded`, and `kind` from this response.
- `GET /students/{studentId}/get_progress_by_task/{taskId}/`: reads `progress_id`
  and, for teacher CHAT, `conversation_node.conversation`.
- `GET /chat_messages/?to_conversation={conversationId}`: `Cnpky7Aq.js`
  consumes an array with `id`, `to_conversation`, `from_who`, `role`, `message`,
  `is_deleted`, `file_storage`, `is_file_image` and `file_name`. The correction reads active
  messages with role `student` from the linked conversation and requires a
  single distinct author. The chat sender user ID and the student record ID
  represent different identifiers in the UI.
- `GET /task_description_materials/?task={taskId}`: array or `results` of
  statement materials. The correction reads embedded images from the authenticated
  task HTML and validates downloads with the server's exact host allowlist.
- The public Learn runtime resolves `PLATFORM_API_V2` to
  `https://backoffice.kodland.org/api/v2/`. Requests use SSO Bearer authentication.
- Before reading chat, the correction confirms the student and task are still
  pending using the authenticated group and lesson progress endpoint below.

Real screen reported: `/pt/task/138971/check/2969558`, CHAT task,
official maximum 50, statement requesting a decorated Roblox location and
a screenshot; delivery contains two images. A text-only evaluation is
insufficient. Criteria must be derived from the statement and labeled as
derived, not presented as official Kodland criteria.

NexusClass uses authenticated `POST /api/assistant/corrections/kodland` to
generate a draft and makes only GET requests to the Backoffice API after SSO
login. The browser vault supplies credentials for the request. The suggestion
stores the score, feedback, context hash and, for official drafts, the private
delivery destination.

### Learn correction publication

The [teacher check bundle](https://learn.kodland.org/_nuxt/DS1Icf3d.js)
uses the shared grading form for CHAT and calls `gradeTask` with
`progress_id`, an integer grade and the form comment. The
[task API plugin](https://learn.kodland.org/_nuxt/fGvgONzy.js) sends both
fields together as JSON in `PUT /grade/{progressId}/` on `PLATFORM_API`,
using an SSO Bearer token. The
[public runtime configuration](https://learn.kodland.org/auth) resolves that
base to `https://backoffice.kodland.org/api/v1/`. Body: `{ grade, comment }`.
The form refreshes `GET /students/{studentId}/get_progress_by_task/{taskId}/`
on API v2. The [feedback component](https://learn.kodland.org/_nuxt/DEMmxZ4z.js)
renders `comment` as a string or as an object with `comment` and `datetime`.

`KODLAND_CORRECTION_WRITE_ENABLED=true` is a server-only opt-in. With the flag
off, approval offers copying and opening the official screen. With the flag
on, the explicit send action supplies only ephemeral vault credentials.
The server takes the destination from the UID-owned draft and revalidates
pending status, the selected progress/conversation and the original snapshot
before sending. A single PUT carries both approved values. A fresh read-back
must match the same progress and conversation, a changed grading timestamp
and both values to mark the result confirmed.

A server-only Firestore reservation uses a hash of the external progress ID.
It carries no UID, credentials, score or feedback. A known pre-dispatch
failure releases it. Once dispatch is possible, it persists across drafts
and account resets to prevent repeat writes, including after a crash.
A partial or uncertain result directs the tutor to the Kodland screen.
With the same progress ID, further corrections use that screen.

The API contract is confirmed by inspection of the public client.
Local fixtures exercise the request body and confirmation in both directions.
No authenticated publication has been performed.

The image allowlist starts empty. Set server-only
`KODLAND_CORRECTION_IMAGE_HOSTS` to comma-separated exact attachment hosts
observed in a verified authenticated response. Image requests pin a public IPv4
address, verify TLS and omit cookies and authorization. The downloader accepts
PNG, JPEG and WebP signatures, with up to four images at 2 MiB each and six
seconds per download. Unsupported files, unknown hosts and incomplete chats
stop the generation. The Gemini request includes verified bytes as `inlineData`.

The task, progress and chat fields come from the public client bundle. The
multimodal path has synthetic regression coverage. Authenticated validation
of the Learn payload and the attachment hosts for the example remains pending.

Last static review: 2026-05-30
Last authenticated HAR review: 2026-06-01

This map was extracted from the public JavaScript bundles loaded by
`https://bo.kodland.org/`. It does not contain credentials, tokens, or private
responses. Kodland may change these internal endpoints without notice.

## API Bases

| Client | Base URL | Purpose |
| --- | --- | --- |
| SSO | `https://sso.production.kodland.org/` | Login, token refresh, permissions |
| Backoffice v1 | `https://backoffice.kodland.org/api/v1/` | Some legacy operations |
| Backoffice v2 | `https://backoffice.kodland.org/api/v2/` | Current teacher, group, student, and schedule screens |

The browser sends `Authorization: Bearer <access_token>`. The access and refresh
tokens must never be logged or persisted in the AulaPay SQLite database.

## Authentication

| Method | Path | Body | Use |
| --- | --- | --- | --- |
| `POST` | `login` | Form: `username`, `password` | Obtain `access_token` and `refresh_token` |
| `POST` | `token` | Form: `grant_type=refresh_token`, `refresh_token` | Renew the access token |
| `GET` | `user_groups/my/` | - | Load permissions from backoffice v2 |

## Read-Only Sync Flow

These are the endpoints needed by AulaPay. They are read-only and should be the
first integration scope.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `teachers/{teacherId}/get_general_info_for_teacher_backoffice_page` | Teacher identity and metadata |
| `GET` | `teachers/{teacherId}/get_teachers_groups/?page={page}&page_size={size}` | Teacher groups |
| `GET` | `student_groups/{groupId}/get_general_info_for_group_backoffice_page` | Group title, teacher, course, timezone, and counters |
| `GET` | `student_groups/{groupId}/get_students_main_data` | Students linked to the group and progress summary |
| `GET` | `student_groups/{groupId}/schedule_view/` | Group lesson schedule |
| `GET` | `student_groups/{groupId}/lessons/` | Group lessons |
| `GET` | `student_groups/{groupId}/lesson/{lessonId}/get_group_progress/` | Lesson task progress by student |
| `GET` | `lessons/get_lessons_list?course={courseId}` | Course lesson catalog and lesson IDs |
| `GET` | `materials?lesson={lessonId}` | Slides and teacher guide links attached to a course lesson |
| `GET` | `tasks/get_tasks_list?lesson={lessonId}&is_hw=true` | Homework tasks attached to a course lesson |
| `GET` | `students/{studentId}/get_general_info_for_student_backoffice_page/` | Student details; sync only allowlisted safe fields |
| `GET` | `students/{studentId}/backoffice_groups/` | Groups linked to one student |

Examples visible in the supplied screenshots:

```text
teachers/3047385/get_teachers_groups/?page=1&page_size=10
student_groups/61918/get_general_info_for_group_backoffice_page
student_groups/61918/get_students_main_data
student_groups/61918/schedule_view/
```

Recommended synchronization sequence:

1. Authenticate with SSO.
2. Read the user ID from the access token payload.
3. Fetch the teacher groups with `teachers/{teacherId}/get_teachers_groups/`.
4. For each group, fetch general info, students, and schedule.
5. Fetch individual student detail only to extract an allowlist of safe fields
   such as phone, email, status, and profile URL. Never persist the full detail
   payload or sensitive fields such as student passwords.
6. Import into AulaPay in one SQLite transaction and retain the last successful
   local snapshot if the remote sync fails.

## Supporting Read Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `students/?page={page}&page_size={size}` | Paginated student list |
| `GET` | `students/get_data_for_filters/` | Student list filters |
| `GET` | `students/get_data_for_edit_form_filters/` | Student edit filters |
| `GET` | `student_groups/?page={page}&page_size={size}` | Paginated group list |
| `GET` | `student_groups/get_data_for_filters/` | Group list filters |
| `GET` | `student_groups/all_group_titles/` | Group title options |
| `GET` | `student_groups/available_groups/` | Available groups |
| `GET` | `student_groups/{groupId}/schedule_view/` | Group schedule |
| `GET` | `zoom_records/?timetable_id={id}&group_id={groupId}` | Lesson recording metadata |
| `GET` | `group_comments/?group={groupId}` | Group comments |
| `GET` | `special_group_lessons/?group={groupId}` | Special lessons |
| `GET` | `special_group_lessons/{lessonId}/attendance/` | Attendance for a special lesson |
| `GET` | `teacher_timetables/{teacherId}` | Teacher availability |
| `GET` | `teachers/{teacherId}/get_teacher_timetable` | Initializes teacher availability when absent |
| `GET` | `teachers/{teacherId}/get_teacher_extra_lessons_timetable/?date={date}` | Scheduled extra lessons shown in the teacher calendar |
| `GET` | `teachers/{teacherId}/get_teachers_courses` | Teacher courses |
| `GET` | `courses?has_groups_for_teacher={teacherId}` | Courses with groups for a teacher |
| `GET` | `groups/types` | Group types |
| `GET` | `utils/get_timezones_with_offsets/` | Timezone choices |
| `GET` | `students/{studentId}/get_all_courses/` | Student course history |
| `GET` | `student_transfers/?student={studentId}` | Student transfer history |

## Authenticated HAR Findings

An authenticated HAR supplied locally on 2026-05-30 confirmed `200` responses
from the current v2 API for the relevant teacher and group screens. The HAR was
inspected locally without copying credentials, tokens, cookies, or personal
payload values into this repository.

The teacher group endpoint returns paginated records with group ID, title,
course, student count, schedule slots, start date, next lesson, and archive
status.

The group student endpoint returns an array with a `main_info` object and a
`progress_info` array for each student. The default AulaPay import should only
retain the minimum fields required for consultation and local linking.

The individual student detail endpoint returns sensitive fields, including a
student platform password. AulaPay may call this endpoint during sync only with
an allowlist parser and must never import or persist sensitive fields.

An authenticated HAR supplied locally on 2026-06-01 confirmed the read-only
lesson progress flow for correction review. `student_groups/{groupId}/lessons/`
returns lesson IDs, lesson numbers, titles, themes, and passed status.
`student_groups/{groupId}/lesson/{lessonId}/get_group_progress/` returns
`lesson_tasks` and `students_progress.tasks_data`. AulaPay treats only
`TASK_SUBMITTED` and `TASK_SUBMITTED_LATE` as pending teacher review, and
ignores `TASK_CHECKED`, `TASK_NOT_SUBMITTED`, and `TASK_NOT_GRADED`. The sync
also skips lessons where `lesson_passed` is not `true`, so future modules do not
create correction items. Task status labels are translated locally in AulaPay;
raw labels such as `Not graded assignment` must not be shown in the UI. When a
task does not include `link_to_service`, AulaPay links the review action to the
group page at `https://bo.kodland.org/groups/{groupId}`.

The course lesson screen keeps the presentation, teacher guide, and homework
outside the group schedule. AulaPay resolves the course ID from each group,
loads the course lesson catalog, then reads `materials?lesson=...` and
`tasks/get_tasks_list?...&is_hw=true`. Only the resulting links and homework
title are persisted; no task content or financial data is imported.

## Administrative Endpoints Excluded From Sync

The portal also exposes mutation endpoints. AulaPay sync must not call them.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `students/` | Create student |
| `PATCH` | `students/{studentId}/edit/` | Edit student |
| `DELETE` | `students/{studentId}/` | Delete student |
| `POST` | `students/{studentId}/change_group/` | Enroll or transfer student |
| `POST` | `students/{studentId}/churn_from_group/` | Remove student from group |
| `POST` | `students/{studentId}/activate_pause_in_learning/` | Pause student |
| `POST` | `students/{studentId}/deactivate_pause_in_learning/` | End pause |
| `POST` | `student_groups/` | Create group |
| `PATCH` | `student_groups/{groupId}/` | Edit group |
| `PATCH` | `timetables/{timetableId}/change_teacher/` | Replace lesson teacher |
| `PATCH` | `timetables/{timetableId}/change_time/` | Change lesson time |
| `PATCH` | `timetables/{timetableId}/reschedule/` | Reschedule lessons |
| `POST` | `group/{groupId}/create_schedule/` | Create schedule |
| `POST` | `group_comments/` | Create group comment |
| `PATCH` | `group_comments/{commentId}/` | Edit group comment |
| `DELETE` | `group_comments/{commentId}/` | Delete group comment |

## Runtime Validation Still Needed

Unauthenticated v1 requests to the example endpoints returned `404` on
2026-05-30. The authenticated HAR subsequently confirmed that the current
screens use v2 endpoints.

Before enabling production sync:

1. Call only the read-only sync flow endpoints.
2. Validate any remaining response shapes without logging credentials, tokens,
   phone numbers, emails, or full API payloads.
3. Add parser fixtures with synthetic responses.

## AulaPay Implementation Status

Implemented on branch `feature/kodland-sync`:

- SSO login and in-memory token handling;
- one automatic access-token refresh after a `401`;
- paginated teacher-group loading from backoffice API v2;
- student loading for active groups;
- pending correction snapshots from group lessons and lesson progress;
- filtered local snapshots without unrelated sensitive fields;
- SQLite persistence for remote groups, students, remote relationships, and
  confirmed local-class links;
- manual class-link selection in the Kodland tab.

Still pending:

- capture and validate the schedule response shape before importing lesson
  dates from Kodland.
