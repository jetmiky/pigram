import { describe, expect, test } from "bun:test";
import {
  type InboundMessage,
  type MappedPrompt,
  mapInboundMessage,
  FollowUpQueue,
} from "../src/domain/prompt.js";

describe("mapInboundMessage", () => {
  test("text-only message prefixes with [telegram] marker", () => {
    const msg: InboundMessage = { text: "hello" };
    const mapped = mapInboundMessage(msg);

    expect(mapped.text).toBe("[telegram] hello");
    expect(mapped.imagePaths).toEqual([]);
    expect(mapped.documentPaths).toEqual([]);
  });

  test("message with images preserves imagePaths in order and prefixes text", () => {
    const msg: InboundMessage = {
      text: "check this out",
      imagePaths: ["/tmp/img1.jpg", "/tmp/img2.png"],
    };
    const mapped = mapInboundMessage(msg);

    expect(mapped.text).toBe("[telegram] check this out");
    expect(mapped.imagePaths).toEqual(["/tmp/img1.jpg", "/tmp/img2.png"]);
    expect(mapped.documentPaths).toEqual([]);
  });

  test("message with no text but documents generates file count note", () => {
    const msg: InboundMessage = {
      documentPaths: ["/tmp/doc1.pdf", "/tmp/doc2.txt"],
    };
    const mapped = mapInboundMessage(msg);

    expect(mapped.text).toBe("[telegram] (sent 2 file(s))");
    expect(mapped.imagePaths).toEqual([]);
    expect(mapped.documentPaths).toEqual(["/tmp/doc1.pdf", "/tmp/doc2.txt"]);
  });

  test("message with no text but single document generates singular file count", () => {
    const msg: InboundMessage = {
      documentPaths: ["/tmp/single.pdf"],
    };
    const mapped = mapInboundMessage(msg);

    expect(mapped.text).toBe("[telegram] (sent 1 file(s))");
    expect(mapped.documentPaths).toEqual(["/tmp/single.pdf"]);
  });

  test("message with no text but images generates file count note", () => {
    const msg: InboundMessage = {
      imagePaths: ["/tmp/img1.jpg", "/tmp/img2.png", "/tmp/img3.gif"],
    };
    const mapped = mapInboundMessage(msg);

    expect(mapped.text).toBe("[telegram] (sent 3 file(s))");
    expect(mapped.imagePaths).toEqual([
      "/tmp/img1.jpg",
      "/tmp/img2.png",
      "/tmp/img3.gif",
    ]);
    expect(mapped.documentPaths).toEqual([]);
  });

  test("message with no text but both images and documents counts total files", () => {
    const msg: InboundMessage = {
      imagePaths: ["/tmp/img1.jpg"],
      documentPaths: ["/tmp/doc1.pdf", "/tmp/doc2.txt"],
    };
    const mapped = mapInboundMessage(msg);

    expect(mapped.text).toBe("[telegram] (sent 3 file(s))");
    expect(mapped.imagePaths).toEqual(["/tmp/img1.jpg"]);
    expect(mapped.documentPaths).toEqual(["/tmp/doc1.pdf", "/tmp/doc2.txt"]);
  });

  test("empty message generates marker-only text", () => {
    const msg: InboundMessage = {};
    const mapped = mapInboundMessage(msg);

    expect(mapped.text).toBe("[telegram] ");
    expect(mapped.imagePaths).toEqual([]);
    expect(mapped.documentPaths).toEqual([]);
  });

  test("message with text and both file types preserves all data", () => {
    const msg: InboundMessage = {
      text: "review these",
      imagePaths: ["/tmp/screenshot.png"],
      documentPaths: ["/tmp/report.pdf"],
    };
    const mapped = mapInboundMessage(msg);

    expect(mapped.text).toBe("[telegram] review these");
    expect(mapped.imagePaths).toEqual(["/tmp/screenshot.png"]);
    expect(mapped.documentPaths).toEqual(["/tmp/report.pdf"]);
  });
});

describe("FollowUpQueue", () => {
  test("enqueue increases size", () => {
    const queue = new FollowUpQueue();
    expect(queue.size).toBe(0);

    queue.enqueue({ text: "first" });
    expect(queue.size).toBe(1);

    queue.enqueue({ text: "second" });
    expect(queue.size).toBe(2);

    queue.enqueue({ text: "third" });
    expect(queue.size).toBe(3);
  });

  test("dequeue returns messages in FIFO order", () => {
    const queue = new FollowUpQueue();

    const msg1: InboundMessage = { text: "first" };
    const msg2: InboundMessage = { text: "second" };
    const msg3: InboundMessage = { text: "third" };

    queue.enqueue(msg1);
    queue.enqueue(msg2);
    queue.enqueue(msg3);

    expect(queue.dequeue()).toBe(msg1);
    expect(queue.size).toBe(2);

    expect(queue.dequeue()).toBe(msg2);
    expect(queue.size).toBe(1);

    expect(queue.dequeue()).toBe(msg3);
    expect(queue.size).toBe(0);
  });

  test("dequeue on empty queue returns undefined", () => {
    const queue = new FollowUpQueue();

    expect(queue.dequeue()).toBeUndefined();
    expect(queue.size).toBe(0);
  });

  test("clear empties the queue", () => {
    const queue = new FollowUpQueue();

    queue.enqueue({ text: "first" });
    queue.enqueue({ text: "second" });
    queue.enqueue({ text: "third" });
    expect(queue.size).toBe(3);

    queue.clear();
    expect(queue.size).toBe(0);
    expect(queue.dequeue()).toBeUndefined();
  });

  test("queue preserves complex messages with all fields", () => {
    const queue = new FollowUpQueue();

    const msg: InboundMessage = {
      text: "complex",
      imagePaths: ["/tmp/img.jpg"],
      documentPaths: ["/tmp/doc.pdf"],
    };

    queue.enqueue(msg);
    const dequeued = queue.dequeue();

    expect(dequeued).toBe(msg);
    expect(dequeued?.text).toBe("complex");
    expect(dequeued?.imagePaths).toEqual(["/tmp/img.jpg"]);
    expect(dequeued?.documentPaths).toEqual(["/tmp/doc.pdf"]);
  });
});
