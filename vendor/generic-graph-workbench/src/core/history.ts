import { applyBatch, type GraphCommand } from "./commands.js";
import type { GraphDocument } from "./types.js";
import { assertValidDocument } from "./validation.js";

export class GraphHistory {
  #document: GraphDocument;
  #stateId: object = {};
  #undo: Array<{ commands: GraphCommand[]; stateId: object }> = [];
  #redo: Array<{ commands: GraphCommand[]; stateId: object }> = [];

  constructor(document: GraphDocument) {
    assertValidDocument(document);
    this.#document = structuredClone(document);
  }

  get document(): GraphDocument {
    return structuredClone(this.#document);
  }

  get canUndo(): boolean {
    return this.#undo.length > 0;
  }

  get canRedo(): boolean {
    return this.#redo.length > 0;
  }

  get stateId(): object {
    return this.#stateId;
  }

  fork(): GraphHistory {
    const fork = new GraphHistory(this.#document);
    fork.#stateId = this.#stateId;
    fork.#undo = this.#undo.map(({ commands, stateId }) => ({
      commands: structuredClone(commands),
      stateId
    }));
    fork.#redo = this.#redo.map(({ commands, stateId }) => ({
      commands: structuredClone(commands),
      stateId
    }));
    return fork;
  }

  execute(commands: readonly GraphCommand[]): GraphDocument {
    const result = applyBatch(this.#document, commands);
    if (result.inverse.length === 0) return this.document;
    const previousStateId = this.#stateId;
    this.#document = result.document;
    this.#stateId = {};
    this.#undo.push({ commands: result.inverse, stateId: previousStateId });
    this.#redo = [];
    return this.document;
  }

  undo(): GraphDocument {
    const entry = this.#undo.pop();
    if (!entry) throw new Error("Nothing to undo");
    const result = applyBatch(this.#document, entry.commands);
    const previousStateId = this.#stateId;
    this.#document = result.document;
    this.#stateId = entry.stateId;
    this.#redo.push({
      commands: result.inverse,
      stateId: previousStateId
    });
    return this.document;
  }

  redo(): GraphDocument {
    const entry = this.#redo.pop();
    if (!entry) throw new Error("Nothing to redo");
    const result = applyBatch(this.#document, entry.commands);
    const previousStateId = this.#stateId;
    this.#document = result.document;
    this.#stateId = entry.stateId;
    this.#undo.push({
      commands: result.inverse,
      stateId: previousStateId
    });
    return this.document;
  }
}
