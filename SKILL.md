---
name: smd-flow
description: Draw what a change or pull request does to the commands, queries, events and processing groups of a Simple Message Dispatch (SMD) application, as one diagram in a light and a dark image. Use when creating or reviewing a pull request that touches SMD handlers, events, commands, queries or processing-group configuration, or when planning a new one.
---

# SMD Flow

The diagram is drawn from two flow files: `smd.smdflow` as it is after the change, and as it was before.

## Steps

1. **Update `smd.smdflow`** at the module root so it matches the code after the change (see [Format](#format) and
   [Reading SMD code](#reading-smd-code)), and commit it with the change: the pull request then shows it as a text
   diff too. Without it the diagram shows nothing, or the wrong thing.
2. **Get the base**: `git show origin/main:smd.smdflow > /tmp/base.smdflow`, using the pull request's base branch. For a
   plan, copy the file and edit it into the intended design instead.
3. **Find the changed commands**: those the change alters without rewiring them, with new or changed fields or a
   handler that now decides differently. The flow files cannot show that; read the diff of each command and handler.
4. **Render** with Node 18 or later:

   ```bash
   node <skill-dir>/render.mjs smd.smdflow --base /tmp/base.smdflow --changed RecordTodoAnalysisCommand
   ```

   Leave out `--changed` when step 3 found none; separate several with commas. It writes `smd-flow-light.svg`,
   `smd-flow-dark.svg` and `smd-flow.md` (`--out <name>` names them otherwise). Fix every error; check every warning
   against the code.
5. **Rewrite the description** in `smd-flow.md` in one or two plain sentences: what the change sets off at runtime.
   Keep what a reviewer could miss: a group that receives an event through a supertype without a code change, a
   medium change, an event no group handles, a removed reaction. Add one line for what the diagram cannot show but the
   change touches: stored event names and upcasters, event routes, sinks, interceptors, metadata, command retries.
6. **Post** the description and the `<picture>` from `smd-flow.md` in the pull request. Upload both SVGs, for example
   with `gh pr edit --attach`, and put their addresses in the `srcset` (dark) and `src` (light).

## Reading a diagram

Icons tell what a node is: an arrow is a command, an envelope an event, a lens a query, a frame a handler, three bars a processing group. A small word on each link says what it means: *handled by*, *publishes*, *delivered to*, *sends*, *reads*, *updated by*.

Colour tells what the change does to a node in that flow, so a reviewer knows where to look:

| Colour | Means | The reviewer |
|--------|-------|--------------|
| green, new | the change creates it | reads new code |
| amber, changed | it exists and the change alters its code or setup: a new or changed handler, a new medium | reads changed code |
| blue, reused here | it exists, the change leaves it alone, and this flow now reaches it | checks what existing behaviour now also runs |
| red, removed here | the change deletes it, or this flow no longer reaches it | checks what stops happening |
| grey | untouched and already part of this flow | context only |

A link has the colour of the node it leads to. Unchanged branches fold into "N other groups", except after an event the change newly reaches: there every group is shown.

## Format

One fact per line; indentation nests a line in the block above; `#` starts a comment. Use class names as in the code.

```text
app ticket-service

events TicketEvent: TicketOpenedEvent TicketClosedEvent

aggregate Ticket
  OpenTicketCommand  -> TicketOpenedEvent
  CloseTicketCommand -> TicketClosedEvent

handler SurveyCommandHandler
  SendSatisfactionSurveyCommand -> SurveySentEvent

group ticket-view sync
  handles TicketOpenedEvent TicketClosedEvent

group ticket-activity event-store
  handles TicketEvent

group satisfaction-survey durable ticket-service.satisfaction-survey
  handles TicketClosedEvent
  sends   SendSatisfactionSurveyCommand

queries TicketQueryHandler
  GetTicketQuery reads ticket-view
```

| Line                                    | Meaning                                                         |
|-----------------------------------------|-----------------------------------------------------------------|
| `app <name>`                            | Title. Optional.                                                |
| `events <Type>: <Event> ...`            | A supertype and its events, for groups that handle the supertype. |
| `aggregate <Class>` / `handler <Class>` | An `@Aggregate`, or a class with `@CommandHandler` methods.      |
| `  <Command> -> <Event> ...`            | A command and every event its handler can publish.              |
| `group <name> <medium> [<dispatcher>]`  | A processing group and its medium.                              |
| `  handles <Event or Type> ...`         | The event types its `@EventHandler` methods take.               |
| `  sends <Command> ...`                 | Commands its handlers send.                                     |
| `queries <Class>`                       | A class with `@QueryHandler` methods.                           |
| `  <Query> reads <group> ...`           | The processing groups whose views the query reads.              |

Media: `sync`, `async-await`, `async-fire-and-forget`, `event-store`, `durable`; any other word is a custom medium. Base and head are compared by name, so a rename is a removal plus an addition.

## Reading SMD code

- **Commands.** An `@AggregateCommandHandler` publishes what it passes to `events.apply(new ...)`; a `@CommandHandler` what it passes to `eventPublisher.publish(new ...)`, including through private methods. List every event on any branch.
- **Events.** A sealed interface over events becomes an `events` line. Events published outside handlers may appear in `handles`; their warning is expected.
- **Groups.** An `@EventHandler` belongs to the `@ProcessingGroup` on its method, else on its class (no value: `default`). `handles` lists first parameter types; `sends` lists commands passed to `commandGateway.send(...)`.
- **Media.** From the `ProcessingGroupsConfigurer` bean or `EventBusSpec...processingGroups(...)`: `.sync()` → `sync`; `.async().await()` → `async-await`; `.async().fireAndForget()` → `async-fire-and-forget`; `.source(eventStore.outlet())` or `.medium(eventStore)` → `event-store`; `.medium(durableDelivery.dispatcher("name"))` or `.source(dispatcher.outlet())` → `durable name`. `anyProcessingGroup()` covers unnamed groups; unconfigured groups are `sync`. Leave out `disabled()` groups.
- **Queries.** Follow the `@QueryHandler`'s repository or view to the `@ProcessingGroup` class that writes it. If none does, leave `reads` empty and say why.
