# A room's state in the browser

Each editor tab keeps one object per room that holds everything the tab
knows about that room. The code calls it the replica
(`src/replica/replica.ts`). This page says what it holds, which states
it can be in, and what it tells a transport.

The rules for combining two people's edits are not here. They belong to
the engine's core (`src/engines/intent-log/`). The replica only decides
when the core runs and what is sent.

## What it holds

- **The confirmed document**: the document as the server last
  described it, with its position in the room's history.
- **The recent history**: the edits the tab still needs to place its
  own unanswered edits correctly.
- **The document the person sees**: the confirmed document plus the
  person's own edits that the server has not answered yet.
- **The outgoing list**: every edit, review decision and cancellation
  the server has not answered, in the order they were made.

The outgoing list is the only place that holds unsent work. A transport
keeps no queue of its own. This rule exists because an edit used to be
lost when a socket closed: the transport's copy went with the socket,
and nothing knew the edit still had to be sent.

Each entry on the list has one mark:

| Mark | Meaning |
|---|---|
| `not-sent` | No connection has carried it. The server cannot have it. |
| `in-flight` | The current connection carried it, and the answer is not here yet. |
| `send-again` | A connection that was lost carried it. The server may or may not have it. Only its answer can tell. |
| `refused` | The server refused it while a reset was waiting (see below). It stays on screen until the reset is taken. |

An example of why `send-again` matters:

1. Alice types "x" over an open socket.
2. The socket closes before the server answers.
3. The entry for "x" changes from `in-flight` to `send-again`.
4. The next connection, polling or a new socket, sends "x" again.
5. If the server had stored "x" the first time, it gives the same
   answer again, because it remembers each edit by its id. The text is
   not there twice.

## The four states

| State | Meaning |
|---|---|
| No document | Before the first document arrives, or after the room was started over. |
| In step | The tab has a document, and no edit is waiting for an answer. |
| Waiting | The tab has a document, and at least one edit is waiting for an answer. |
| Reset waiting | The server sent a newer whole copy of the document, and an edit that was sent has no answer yet. |

A reset is a whole new copy of the document. A tab gets one only when
it fell far behind, for example after it was offline while other people
made hundreds of edits. The server can no longer place the tab's older
edits, so the tab must build the person's work again on the new copy.

The tab does not take the new copy at once when an edit is on its way.
Only that edit's answer says whether the new copy already holds it. So
the tab waits for the answers, for at most
<!-- const:RESET_WAIT_LIMIT_MS -->10000<!-- /const --> milliseconds.
After that, an edit with no answer is treated as refused and built
again on the new copy. If the server had stored it after all, its text
is there twice. That is better than losing it.

Keys typed during the wait are kept and not sent, so they cannot make
the wait longer. Edits that no connection ever carried do not cause a
wait at all.

## What happens on each event

| Event | In step or Waiting | Reset waiting |
|---|---|---|
| The person edits | The edit is applied to the document the person sees and joins the list as `not-sent`. The transport is told that work is waiting. | The same, but the transport is not told. The edit is built again after the reset. |
| The transport asks what to send | Every entry that is not `in-flight`, oldest first, up to the size the transport allows. They become `in-flight`. | Only `send-again` entries, to get their answers. |
| Rows arrive from the server | All rows of one answer are taken together. A row with a lower number than expected is skipped. A gap in the numbers means a row is missing, and the room starts over. | Kept in order behind the new copy, and applied when it is taken. |
| An answer arrives for an edit | The edit leaves the list. Undo and review are told. | The edit leaves the list, or is marked `refused`. When nothing sent is left without an answer, the new copy is taken. |
| The connection is lost | Every `in-flight` entry becomes `send-again`. | The same. |
| The server started the room over, or a row is missing | The document, the history and the list are dropped. The editor keeps what it shows, and the difference is sent as new edits after the next first document. | The same. |
| Undo cancels edits with no answer | If none was sent, they leave the list and nothing is sent. If any was sent, one cancellation joins the list. | Undo waits for the reset. |
| A review decision is made | The item closes at once, and the decision joins the list. | The same. It is sent after the reset. |

Before the first document arrives the tab sends nothing. The editor
code keeps the person's edits until then.

## What a transport and a session say to each other

A session is the engine's object for one room in one tab. It owns the
replica. The shared types are in `src/registry/types.ts`, and they name
no engine.

| Call | Who calls it | Meaning |
|---|---|---|
| `onWorkWaiting( listener )` | Transport | "Tell me when you have something to send." The call carries a size, not the edits. |
| `hasUpdatesToSend()` | Transport | Asked before a timer fires, so a request is not made for nothing. |
| `takeUpdatesToSend( { maxBytes } )` | Transport | "Give me what fits in this request." The entries become `in-flight`. |
| `receiveUpdates( updates )` | Transport | The rows of one answer, in one call. |
| `connectionLost()` | Transport | A request failed, a socket closed, or the room moved to the other transport. |

Both transports follow the same rule. Polling asks each room's session
when it builds a request. The WebSocket asks when the session says work
is waiting and the socket is open. When a socket closes, the session is
told before polling takes the room over, so nothing is handed from one
transport to the other.
