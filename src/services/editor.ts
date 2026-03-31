import { FileSystem } from "@effect/platform"
import { Context, Console, Effect, Layer } from "effect"
import { ShellService } from "./shell.js"
import { ConfigService } from "./config.js"
import { ShipConfig } from "../schema/config.js"
import { bold, dim } from "../fmt.js"

// ---------------------------------------------------------------------------
// EditorService
// ---------------------------------------------------------------------------

export class EditorService extends Context.Tag("EditorService")<
  EditorService,
  {
    readonly open: (path: string) => Effect.Effect<void>
  }
>() {}

/** GUI editors: cmd is the CLI binary, app is the macOS .app name */
const GUI_EDITORS = [
  { cmd: "zed", app: "Zed" },
  { cmd: "cursor", app: "Cursor" },
  { cmd: "code", app: "Visual Studio Code" },
  { cmd: "subl", app: "Sublime Text" },
] as const

const TERMINAL_EDITORS = ["nvim", "vim", "vi"] as const

export const EditorServiceLive = Layer.effect(
  EditorService,
  Effect.gen(function* () {
    const shell = yield* ShellService
    const config = yield* ConfigService
    const fs = yield* FileSystem.FileSystem

    const tryExec = (cmd: string, args: ReadonlyArray<string>): Effect.Effect<boolean> =>
      shell.exec(cmd, args).pipe(
        Effect.as(true),
        Effect.catchAll(() => Effect.succeed(false))
      )

    const appExists = (app: string): Effect.Effect<boolean> =>
      fs.exists(`/Applications/${app}.app`).pipe(
        Effect.catchAll(() => Effect.succeed(false))
      )

    /** Try to open path: CLI command first, then `open -a` fallback for GUI editors */
    const openWith = (editor: string, path: string): Effect.Effect<boolean> => {
      const gui = GUI_EDITORS.find((e) => e.cmd === editor)
      if (gui) {
        // Try CLI first (better integration — opens in existing window)
        // Then fall back to `open -a` (works even if CLI isn't in PATH)
        return tryExec(editor, [path]).pipe(
          Effect.flatMap((ok) => ok ? Effect.succeed(true) : tryExec("open", ["-a", gui.app, path]))
        )
      }
      return tryExec(editor, [path])
    }

    /** Detect best available editor without opening anything */
    const detect = Effect.gen(function* () {
      if (process.env.VISUAL) return process.env.VISUAL
      if (process.env.EDITOR) return process.env.EDITOR

      // Check GUI editors via /Applications (doesn't depend on PATH)
      for (const { cmd, app } of GUI_EDITORS) {
        if (yield* appExists(app)) return cmd
      }

      // Terminal editors via PATH
      for (const cmd of TERMINAL_EDITORS) {
        if (yield* tryExec("which", [cmd])) return cmd
      }

      return "vi"
    })

    return EditorService.of({
      open: (path) =>
        Effect.gen(function* () {
          const shipConfig = yield* config.loadConfig().pipe(
            Effect.catchAll(() => Effect.succeed(new ShipConfig({ projects: {} })))
          )

          // 1. If editor saved in config, try it
          if (shipConfig.editor) {
            yield* Console.log(`  Opening in ${bold(shipConfig.editor)}...`)
            if (yield* openWith(shipConfig.editor, path)) return
            yield* Console.log(`  ${dim(`${shipConfig.editor} failed, detecting another...`)}`)
          }

          // 2. Detect and try
          const editor = yield* detect
          yield* Console.log(`  Opening in ${bold(editor)}...`)

          if (yield* openWith(editor, path)) {
            // Persist working editor to config
            yield* config.saveConfig(new ShipConfig({ ...shipConfig, editor })).pipe(
              Effect.catchAll(() => Effect.void)
            )
          } else {
            yield* Console.log(`  ${dim("No editor found. Set $EDITOR or $VISUAL.")}`)
          }
        })
    })
  })
)
