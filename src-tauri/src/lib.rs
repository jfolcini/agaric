pub mod cache;
pub mod commands;
pub mod dag;
pub mod db;
pub mod device;
pub mod draft;
pub mod error;
pub mod fts;
pub mod hash;
pub mod materializer;
pub mod merge;
pub mod op;
pub mod op_log;
pub mod pagination;
pub mod recovery;
pub mod soft_delete;
pub mod tag_query;
pub mod ulid;

#[cfg(test)]
mod command_integration_tests;
#[cfg(test)]
mod integration_tests;

#[cfg(test)]
mod specta_tests {
    use tauri_specta::{collect_commands, Builder};

    /// Build the tauri-specta [`Builder`] with every registered command.
    ///
    /// Shared between the export test and (potentially) runtime setup so the
    /// command list stays in sync.
    fn specta_builder() -> Builder {
        Builder::<tauri::Wry>::new().commands(collect_commands![
            crate::commands::create_block,
            crate::commands::edit_block,
            crate::commands::delete_block,
            crate::commands::restore_block,
            crate::commands::purge_block,
            crate::commands::move_block,
            crate::commands::list_blocks,
            crate::commands::get_block,
            crate::commands::add_tag,
            crate::commands::remove_tag,
            crate::commands::get_backlinks,
            crate::commands::get_block_history,
            crate::commands::get_conflicts,
            crate::commands::get_status,
            crate::commands::search_blocks,
            crate::commands::query_by_tags,
            crate::commands::list_tags_by_prefix,
        ])
    }

    /// Verify the generated TypeScript bindings match the committed file.
    ///
    /// Writes to a temp file and compares against `src/lib/bindings.ts`.
    /// To regenerate: `cargo test -p block-notes-lib -- specta_tests --ignored`
    #[test]
    fn ts_bindings_up_to_date() {
        let builder = specta_builder();
        let tmp = std::env::temp_dir().join("blocknotes_bindings_check.ts");
        builder
            .export(
                specta_typescript::Typescript::default()
                    .bigint(specta_typescript::BigIntExportBehavior::Number),
                &tmp,
            )
            .expect("Failed to export TypeScript bindings to temp file");

        let generated = std::fs::read_to_string(&tmp).expect("read generated");
        let committed_path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/lib/bindings.ts");
        let committed = std::fs::read_to_string(&committed_path)
            .expect("read committed bindings.ts — run the ignored regenerate test first");

        // Normalize: trim trailing whitespace, strip `// @ts-nocheck` header,
        // and trim leading/trailing blank lines so minor whitespace differences
        // between specta output and the committed file don't cause spurious diffs.
        let norm = |s: &str| -> String {
            let lines: Vec<&str> = s
                .lines()
                .map(|l| l.trim_end())
                .filter(|l| *l != "// @ts-nocheck")
                .collect();
            // Trim leading and trailing empty lines
            let start = lines.iter().position(|l| !l.is_empty()).unwrap_or(0);
            let end = lines
                .iter()
                .rposition(|l| !l.is_empty())
                .map_or(0, |i| i + 1);
            lines[start..end].join("\n")
        };

        assert_eq!(
            norm(&generated),
            norm(&committed),
            "TypeScript bindings are stale — regenerate with: \
             cd src-tauri && cargo test -p block-notes-lib -- specta_tests --ignored"
        );
    }

    /// Regenerate `src/lib/bindings.ts` from the current Rust types.
    ///
    /// Run manually: `cd src-tauri && cargo test -p block-notes-lib -- specta_tests --ignored`
    #[test]
    #[ignore]
    fn regenerate_ts_bindings() {
        let builder = specta_builder();
        let out_path = "../src/lib/bindings.ts";
        builder
            .export(
                specta_typescript::Typescript::default()
                    .bigint(specta_typescript::BigIntExportBehavior::Number),
                out_path,
            )
            .expect("Failed to export TypeScript bindings");

        // Prepend `// @ts-nocheck` so tsc ignores unused specta-generated declarations
        let content = std::fs::read_to_string(out_path).expect("read generated bindings");
        std::fs::write(out_path, format!("// @ts-nocheck\n{content}"))
            .expect("write bindings with ts-nocheck header");
    }
}

#[cfg(not(tarpaulin_include))]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use device::DeviceId;
    use materializer::Materializer;
    use tauri::Manager;
    use tauri_specta::{collect_commands, Builder};

    let builder = Builder::<tauri::Wry>::new().commands(collect_commands![
        commands::create_block,
        commands::edit_block,
        commands::delete_block,
        commands::restore_block,
        commands::purge_block,
        commands::move_block,
        commands::list_blocks,
        commands::get_block,
        commands::add_tag,
        commands::remove_tag,
        commands::get_backlinks,
        commands::get_block_history,
        commands::get_conflicts,
        commands::get_status,
        commands::search_blocks,
        commands::query_by_tags,
        commands::list_tags_by_prefix,
    ]);

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Resolve the OS-standard app data directory from tauri.conf.json identifier
            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;
            let db_path = app_data_dir.join("notes.db");

            // Initialize the pool synchronously during setup (runs migrations)
            let pool = tauri::async_runtime::block_on(db::init_pool(&db_path))?;

            // Read or generate a persistent device UUID (ADR-07)
            let device_id_path = app_data_dir.join("device-id");
            let device_id = device::get_or_create_device_id(&device_id_path)?;

            // Run crash recovery before anything else (ADR-07)
            let report =
                tauri::async_runtime::block_on(recovery::recover_at_boot(&pool, &device_id))?;
            if !report.drafts_recovered.is_empty() {
                eprintln!(
                    "[boot] Recovered {} unflushed drafts",
                    report.drafts_recovered.len()
                );
            }

            // Create materializer (spawns consumer tasks)
            let materializer = Materializer::new(pool.clone());

            // Store all in Tauri managed state
            app.manage(pool);
            app.manage(DeviceId(device_id));
            app.manage(materializer);

            Ok(())
        })
        .invoke_handler(builder.invoke_handler())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
