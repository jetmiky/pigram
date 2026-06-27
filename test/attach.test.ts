import { describe, expect, test } from "bun:test";
import {
  type Attachment,
  type AttachmentSender,
  AttachmentQueue,
  MAX_ATTACHMENTS_PER_TURN,
  buildAttachToolParams,
  executeAttach,
  flushAttachments,
} from "../src/pi/attach.js";

describe("AttachmentQueue", () => {
  test("add computes fileName from basename and increments size", () => {
    const queue = new AttachmentQueue();
    expect(queue.size).toBe(0);

    const att1 = queue.add("/tmp/document.pdf");
    expect(att1.path).toBe("/tmp/document.pdf");
    expect(att1.fileName).toBe("document.pdf");
    expect(queue.size).toBe(1);

    const att2 = queue.add("/home/user/photo.jpg");
    expect(att2.path).toBe("/home/user/photo.jpg");
    expect(att2.fileName).toBe("photo.jpg");
    expect(queue.size).toBe(2);
  });

  test("add handles paths without directories", () => {
    const queue = new AttachmentQueue();
    const att = queue.add("standalone.txt");
    expect(att.path).toBe("standalone.txt");
    expect(att.fileName).toBe("standalone.txt");
  });

  test("drain returns all queued attachments and empties queue", () => {
    const queue = new AttachmentQueue();

    queue.add("/tmp/file1.txt");
    queue.add("/tmp/file2.txt");
    queue.add("/tmp/file3.txt");
    expect(queue.size).toBe(3);

    const drained = queue.drain();
    expect(drained).toHaveLength(3);
    expect(drained[0]).toEqual({ path: "/tmp/file1.txt", fileName: "file1.txt" });
    expect(drained[1]).toEqual({ path: "/tmp/file2.txt", fileName: "file2.txt" });
    expect(drained[2]).toEqual({ path: "/tmp/file3.txt", fileName: "file3.txt" });

    expect(queue.size).toBe(0);
  });

  test("drain on empty queue returns empty array", () => {
    const queue = new AttachmentQueue();
    const drained = queue.drain();
    expect(drained).toEqual([]);
    expect(queue.size).toBe(0);
  });

  test("clear empties the queue", () => {
    const queue = new AttachmentQueue();
    queue.add("/tmp/file1.txt");
    queue.add("/tmp/file2.txt");
    expect(queue.size).toBe(2);

    queue.clear();
    expect(queue.size).toBe(0);
    expect(queue.drain()).toEqual([]);
  });

  test("add beyond MAX throws Attachment limit reached", () => {
    const queue = new AttachmentQueue();

    // Fill to MAX
    for (let i = 0; i < MAX_ATTACHMENTS_PER_TURN; i++) {
      queue.add(`/tmp/file${i}.txt`);
    }
    expect(queue.size).toBe(MAX_ATTACHMENTS_PER_TURN);

    // Attempt to add one more
    expect(() => queue.add("/tmp/excess.txt")).toThrow(
      "Attachment limit reached (10)"
    );
    expect(queue.size).toBe(MAX_ATTACHMENTS_PER_TURN);
  });

  test("addMany adds all paths in order", () => {
    const queue = new AttachmentQueue();

    const paths = ["/tmp/a.txt", "/tmp/b.txt", "/tmp/c.txt"];
    const added = queue.addMany(paths);

    expect(added).toHaveLength(3);
    expect(added[0]).toEqual({ path: "/tmp/a.txt", fileName: "a.txt" });
    expect(added[1]).toEqual({ path: "/tmp/b.txt", fileName: "b.txt" });
    expect(added[2]).toEqual({ path: "/tmp/c.txt", fileName: "c.txt" });
    expect(queue.size).toBe(3);
  });

  test("addMany respects MAX limit and throws if exceeded", () => {
    const queue = new AttachmentQueue();

    // Add 8 files
    for (let i = 0; i < 8; i++) {
      queue.add(`/tmp/file${i}.txt`);
    }
    expect(queue.size).toBe(8);

    // Attempt to add 3 more (would exceed MAX of 10)
    const paths = ["/tmp/x.txt", "/tmp/y.txt", "/tmp/z.txt"];
    expect(() => queue.addMany(paths)).toThrow("Attachment limit reached (10)");

    // Queue should still have the original 8 (addMany is atomic — either all or none)
    expect(queue.size).toBe(8);
  });

  test("addMany with exactly MAX paths succeeds", () => {
    const queue = new AttachmentQueue();

    const paths = Array.from(
      { length: MAX_ATTACHMENTS_PER_TURN },
      (_, i) => `/tmp/file${i}.txt`
    );
    const added = queue.addMany(paths);

    expect(added).toHaveLength(MAX_ATTACHMENTS_PER_TURN);
    expect(queue.size).toBe(MAX_ATTACHMENTS_PER_TURN);
  });
});

describe("flushAttachments", () => {
  test("drains queue and sends each attachment via sender", async () => {
    const queue = new AttachmentQueue();
    queue.add("/tmp/file1.txt");
    queue.add("/tmp/file2.pdf");
    queue.add("/tmp/file3.jpg");

    const calls: Array<{
      chatId: number;
      filePath: string;
      fileName: string;
      caption?: string;
    }> = [];

    const mockSender: AttachmentSender = {
      sendDocument: async (opts) => {
        calls.push(opts);
        return { message_id: 123 };
      },
    };

    const count = await flushAttachments(queue, mockSender, 456789);

    expect(count).toBe(3);
    expect(queue.size).toBe(0);

    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({
      chatId: 456789,
      filePath: "/tmp/file1.txt",
      fileName: "file1.txt",
    });
    expect(calls[1]).toEqual({
      chatId: 456789,
      filePath: "/tmp/file2.pdf",
      fileName: "file2.pdf",
    });
    expect(calls[2]).toEqual({
      chatId: 456789,
      filePath: "/tmp/file3.jpg",
      fileName: "file3.jpg",
    });
  });

  test("returns 0 when queue is empty", async () => {
    const queue = new AttachmentQueue();

    const mockSender: AttachmentSender = {
      sendDocument: async () => {
        throw new Error("Should not be called");
      },
    };

    const count = await flushAttachments(queue, mockSender, 123);
    expect(count).toBe(0);
  });

  test("propagates errors from sender", async () => {
    const queue = new AttachmentQueue();
    queue.add("/tmp/file.txt");

    const mockSender: AttachmentSender = {
      sendDocument: async () => {
        throw new Error("Network error");
      },
    };

    await expect(
      flushAttachments(queue, mockSender, 123)
    ).rejects.toThrow("Network error");
  });
});

describe("executeAttach", () => {
  test("queues valid files and returns added list", async () => {
    const queue = new AttachmentQueue();

    const fakeStatFile = async (path: string) => {
      return {
        isFile: () => true,
      };
    };

    const result = await executeAttach(
      { paths: ["/tmp/a.txt", "/tmp/b.pdf"] },
      queue,
      fakeStatFile
    );

    expect(result.added).toEqual(["/tmp/a.txt", "/tmp/b.pdf"]);
    expect(queue.size).toBe(2);
  });

  test("throws when path is not a file", async () => {
    const queue = new AttachmentQueue();

    const fakeStatFile = async (path: string) => {
      return {
        isFile: () => path !== "/tmp/directory",
      };
    };

    await expect(
      executeAttach(
        { paths: ["/tmp/file.txt", "/tmp/directory"] },
        queue,
        fakeStatFile
      )
    ).rejects.toThrow("Not a file: /tmp/directory");

    // First file should have been added before the error
    expect(queue.size).toBe(1);
  });

  test("validates all paths via statFile", async () => {
    const queue = new AttachmentQueue();
    const checkedPaths: string[] = [];

    const fakeStatFile = async (path: string) => {
      checkedPaths.push(path);
      return {
        isFile: () => true,
      };
    };

    await executeAttach(
      { paths: ["/tmp/a.txt", "/tmp/b.txt", "/tmp/c.txt"] },
      queue,
      fakeStatFile
    );

    expect(checkedPaths).toEqual(["/tmp/a.txt", "/tmp/b.txt", "/tmp/c.txt"]);
  });

  test("propagates file system errors from statFile", async () => {
    const queue = new AttachmentQueue();

    const fakeStatFile = async (path: string) => {
      throw new Error("ENOENT: no such file");
    };

    await expect(
      executeAttach({ paths: ["/tmp/missing.txt"] }, queue, fakeStatFile)
    ).rejects.toThrow("ENOENT: no such file");
  });
});

describe("buildAttachToolParams", () => {
  test("returns schema with paths array constrained to 1-10 items", () => {
    const schema = buildAttachToolParams();

    // Verify the schema structure
    expect(schema.type).toBe("object");
    expect(schema.properties).toBeDefined();
    expect(schema.properties?.paths).toBeDefined();

    const pathsSchema = schema.properties?.paths;
    expect(pathsSchema?.type).toBe("array");
    expect(pathsSchema?.minItems).toBe(1);
    expect(pathsSchema?.maxItems).toBe(MAX_ATTACHMENTS_PER_TURN);

    // Verify items are strings
    expect(pathsSchema?.items).toBeDefined();
    expect(pathsSchema?.items?.type).toBe("string");
  });

  test("MAX_ATTACHMENTS_PER_TURN is 10", () => {
    expect(MAX_ATTACHMENTS_PER_TURN).toBe(10);
  });
});
