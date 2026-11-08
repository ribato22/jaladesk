// What the main process asks of the sender of a message before it does anything with it: which window sent it, from which page, and whether that frame is the top one of the window. ipcAllowed (protocols/rdp/owner.ts)
// compares this with the window and the page that are expected. The description is made here, from the event of Electron, so that it is one thing in every place that checks a sender and a test can reach it.
export type SenderEvent = { sender: { id: number; mainFrame: unknown }; senderFrame?: { url?: string } | null };
export type Sender = { senderId: number; frameUrl: string; isMainFrame: boolean };

export function senderOf(event: SenderEvent): Sender {
  return { senderId: event.sender.id, frameUrl: event.senderFrame?.url || '', isMainFrame: event.senderFrame === event.sender.mainFrame };
}
