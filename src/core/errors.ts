export class RushesError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends RushesError {
  constructor(what: string, id: string) {
    super(`${what} "${id}" not found`, 404, "not_found", { what, id });
  }
}

export class InvalidError extends RushesError {
  constructor(message: string, issues: unknown = []) {
    super(message, 400, "invalid", { issues });
  }
}

export class RevConflictError extends RushesError {
  constructor(file: string, expected: number, current: number) {
    super(`${file} changed (expected rev ${expected}, now ${current})`, 409, "rev_conflict", { file, expected, current });
  }
}

export class CorruptFileError extends RushesError {
  constructor(file: string, reason: string) {
    super(`${file} can't be read: ${reason}. It was not changed.`, 500, "corrupt_file", { file, reason });
  }
}

export class EmptyBatchError extends RushesError {
  constructor(stage: string) {
    super(`Nothing open on the ${stage} tab to send`, 409, "empty_batch", { stage });
  }
}
