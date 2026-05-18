import { Command } from "@effect/cli"
import { Effect } from "effect"
import { UpdaterService } from "../services/updater.js"

// Hidden subcommand spawned by the background refresh worker. Not listed
// in the help text. Errors are swallowed — the worker is best-effort.
export const refreshUpdateCacheCommand = Command.make(
  "__refresh-update-cache",
  {},
  () =>
    Effect.gen(function* () {
      const updater = yield* UpdaterService
      yield* updater.refreshCache().pipe(Effect.ignore)
    })
)
