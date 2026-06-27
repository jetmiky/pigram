import { basename } from "node:path";
import { stat } from "node:fs/promises";
import { Type } from "@sinclair/typebox";

export interface Attachment {
  path: string;
  fileName: string;
}

export const MAX_ATTACHMENTS_PER_TURN = 10;

export class AttachmentQueue {
  private queue: Attachment[] = [];

  add(path: string): Attachment {
    if (this.queue.length >= MAX_ATTACHMENTS_PER_TURN) {
      throw new Error("Attachment limit reached (10)");
    }

    const attachment: Attachment = {
      path,
      fileName: basename(path),
    };

    this.queue.push(attachment);
    return attachment;
  }

  addMany(paths: string[]): Attachment[] {
    // Check if adding all paths would exceed the limit
    if (this.queue.length + paths.length > MAX_ATTACHMENTS_PER_TURN) {
      throw new Error("Attachment limit reached (10)");
    }

    const added: Attachment[] = [];
    for (const path of paths) {
      added.push(this.add(path));
    }
    return added;
  }

  drain(): Attachment[] {
    const drained = [...this.queue];
    this.queue = [];
    return drained;
  }

  get size(): number {
    return this.queue.length;
  }

  clear(): void {
    this.queue = [];
  }
}

export interface AttachmentSender {
  sendDocument(opts: {
    chatId: number;
    filePath: string;
    fileName: string;
    caption?: string;
  }): Promise<{ message_id: number }>;
}

export async function flushAttachments(
  queue: AttachmentQueue,
  sender: AttachmentSender,
  chatId: number
): Promise<number> {
  const attachments = queue.drain();

  for (const attachment of attachments) {
    await sender.sendDocument({
      chatId,
      filePath: attachment.path,
      fileName: attachment.fileName,
    });
  }

  return attachments.length;
}

export function buildAttachToolParams() {
  return Type.Object({
    paths: Type.Array(Type.String(), {
      minItems: 1,
      maxItems: MAX_ATTACHMENTS_PER_TURN,
    }),
  });
}

export async function executeAttach(
  params: { paths: string[] },
  queue: AttachmentQueue,
  statFile: (p: string) => Promise<{ isFile: () => boolean }> = stat
): Promise<{ added: string[] }> {
  const added: string[] = [];

  for (const path of params.paths) {
    const stats = await statFile(path);
    if (!stats.isFile()) {
      throw new Error(`Not a file: ${path}`);
    }
    queue.add(path);
    added.push(path);
  }

  return { added };
}
