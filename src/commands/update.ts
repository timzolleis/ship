import { Command } from "@effect/cli"
import { Console, Effect } from "effect"
import { UpdaterService } from "../services/updater.js"
import { VERSION } from "../version.js"
import { bold, dim, green } from "../fmt.js"

export const updateCommand = Command.make("update", {}, () =>
  Effect.gen(function* () {
    const updater = yield* UpdaterService
    yield* Console.log(`${dim("Current:")} ${VERSION}`)

    const latest = yield* updater.fetchLatestVersion()
    if (latest === VERSION) {
      yield* Console.log(`${dim("Latest: ")} ${latest}  ${dim("(up to date)")}`)
      return
    }

    yield* Console.log(`${dim("Latest: ")} ${bold(latest)}  ${dim("(updating…)")}`)
    yield* updater.installLatest(latest)
    yield* Console.log(green(`✓ Updated to ${latest}.`))
    yield* Console.log(dim("Run 'ship --version' to confirm."))
  }).pipe(
    Effect.catchAll((e) => Console.error(`Error: ${e.message}`))
  )
)
