# SMD Flow

An agent skill that draws what a change does to the message flows of a [Simple Message Dispatch](https://github.com/DavidOpDeBeeck/simple-message-dispatch) application, as one diagram for the pull request. The flows live in a small text file next to the code, `smd.smdflow`; the diagram compares it before and after the change.

This change to the flow file:

```diff
 aggregate Ticket
   OpenTicketCommand  -> TicketOpenedEvent
+  CloseTicketCommand -> TicketClosedEvent

 group ticket-view sync
-  handles TicketOpenedEvent
+  handles TicketOpenedEvent TicketClosedEvent
+
+group notifications durable ticket.notifications
+  handles TicketClosedEvent
```

draws this:

<picture><source media="(prefers-color-scheme: dark)" srcset="examples/new-flow/smd-flow-dark.svg"><img src="examples/new-flow/smd-flow-light.svg" alt="CloseTicket, handled by Ticket, publishes TicketClosed, delivered to ticket-view and the new notifications group"></picture>

## Quick start

```bash
git clone https://github.com/DavidOpDeBeeck/smd-flow ~/.claude/skills/smd-flow
```

Then ask your agent to "add the SMD flow of this change to the pull request". Following [SKILL.md](SKILL.md), it updates `smd.smdflow` from the code, draws the diagram and puts it in the pull request.

## Render by hand

With Node 18 or later:

```bash
node render.mjs smd.smdflow --base base.smdflow
```

| Option | |
|--------|---|
| `<head.smdflow>` | the flows after the change, in the [format](SKILL.md#format) the skill describes |
| `--base <file>` | the flows before the change, such as `git show origin/main:smd.smdflow` |
| `--changed <Command,...>` | commands whose fields or handling change without new wiring, which the flows cannot show |
| `--out <name>` | writes `<name>-light.svg`, `<name>-dark.svg` and `<name>.md`; `smd-flow` by default |

The `.md` holds a short description and a `<picture>` that shows the image matching the reader's GitHub theme.

## Reading a diagram

Each row is a flow: a command, the handler that takes it, the events it publishes and the processing groups they are delivered to. Colour says what the change does to each part of that flow:

- **green, new**: the change creates it
- **amber, changed**: it exists and the change alters its code or setup
- **blue, reused here**: it exists, the change leaves it alone, and this flow now reaches it
- **red, removed here**: the change deletes it, or this flow no longer reaches it
- **grey**: untouched, already part of this flow

## Examples

**A processing group moves to another medium:**

<picture><source media="(prefers-color-scheme: dark)" srcset="examples/medium-change/smd-flow-dark.svg"><img src="examples/medium-change/smd-flow-light.svg" alt="notifications moves from async, awaited to a durable dispatcher"></picture>

**A processing group stops handling an event:**

<picture><source media="(prefers-color-scheme: dark)" srcset="examples/removed-reaction/smd-flow-dark.svg"><img src="examples/removed-reaction/smd-flow-light.svg" alt="notifications no longer handles TicketAssigned"></picture>

**A processing group starts another flow by sending a command:**

<picture><source media="(prefers-color-scheme: dark)" srcset="examples/group-starts-flow/smd-flow-dark.svg"><img src="examples/group-starts-flow/smd-flow-light.svg" alt="the new satisfaction-survey group sends SendSurvey, which SurveyCommandHandler handles"></picture>

**A command changes without new wiring**, drawn with `--changed ResolveTicketCommand`:

<picture><source media="(prefers-color-scheme: dark)" srcset="examples/changed-command/smd-flow-dark.svg"><img src="examples/changed-command/smd-flow-light.svg" alt="ResolveTicket and its handler Ticket are changed"></picture>

`examples/render.sh` draws these from each example's `base.smdflow` and `head.smdflow`.

[MIT License](LICENSE)
