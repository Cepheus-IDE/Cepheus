mod agent;
mod harness;
mod browser;
mod browser_server;
mod ext;
mod fs_cmds;
mod git;
mod history;
mod proc_util;
mod procs;
mod search;
mod settings;
mod userdata;
mod ssh;
mod terminal;
mod vfs;
mod watcher;
mod policy;
mod net;
mod profiles;
mod sync;
mod updater;
mod continuity;
mod devcontainer;

pub fn run() {
    tauri::Builder::default()
        // Single-instance must be the first plugin; deep links are routed to the running window.
        .plugin(continuity::single_instance())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(continuity::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(terminal::TermState::default())
        .manage(agent::AgentState::default())
        .manage(watcher::WatchState::default())
        .manage(procs::ProcState::default())
        .manage(updater::UpdateState::default())
        .invoke_handler(tauri::generate_handler![
            fs_cmds::read_dir,
            fs_cmds::read_file,
            fs_cmds::write_file,
            fs_cmds::create_dir,
            fs_cmds::rename_path,
            fs_cmds::delete_path,
            fs_cmds::path_exists,
            search::search_files,
            search::list_files,
            terminal::term_spawn,
            terminal::term_write,
            terminal::term_resize,
            terminal::term_kill,
            ssh::ssh_connect,
            ssh::ssh_disconnect,
            ssh::ssh_list,
            ssh::ssh_term_spawn,
            ssh::ssh_term_write,
            ssh::ssh_term_resize,
            ssh::ssh_term_kill,
            ssh::ssh_config_hosts,
            git::git_status,
            git::git_stage,
            git::git_unstage,
            git::git_commit,
            git::git_discard,
            git::git_show_head,
            git::git_init,
            git::git_diff_staged,
            git::git_branches,
            git::git_checkout,
            git::git_sync,
            git::git_clone,
            git::git_remote,
            git::git_publish,
            git::git_current_branch,
            git::git_blame,
            git::git_stash_list,
            git::git_stash,
            git::git_identity,
            git::git_set_identity,
            git::git_show_rev,
            git::git_log,
            git::git_commit_details,
            git::git_refs,
            git::git_run,
            git::git_apply,
            ext::openvsx_search,
            ext::openvsx_meta,
            ext::openvsx_text,
            fs_cmds::read_data_url,
            ext::ext_install,
            ext::ext_list,
            ext::ext_uninstall,
            ext::vscode_detect,
            ext::vscode_import,
            ext::ext_configure,
            ext::ext_preinstall,
            policy::policy_get,
            net::net_configure,
            profiles::profiles_load,
            profiles::profiles_save,
            profiles::profile_snippets_dir,
            profiles::profile_snippets_read,
            profiles::profile_snippets_write,
            profiles::profile_delete_data,
            profiles::profile_export,
            profiles::profile_import,
            sync::sync_fetch,
            sync::sync_push,
            updater::update_config,
            updater::update_check,
            updater::update_download,
            updater::update_install,
            continuity::deep_link_take,
            devcontainer::devcontainer_detect,
            devcontainer::devcontainer_up,
            devcontainer::devcontainer_stop,
            devcontainer::devcontainer_shell,
            history::history_save,
            history::history_list,
            history::history_read,
            settings::load_settings,
            settings::save_settings,
            userdata::user_config_dir,
            watcher::watch_folder,
            agent::agent_send,
            agent::agent_cancel,
            agent::agent_approve,
            agent::agent_reset,
            agent::agent_steer,
            agent::agent_customizations,
            agent::mcp_status,
            agent::mcp_start,
            agent::mcp_stop,
            agent::persist::agent_sessions_load,
            agent::persist::agent_session_save,
            agent::persist::agent_session_delete,
            agent::ai_oneshot,
            agent::nvidia_models,
            agent::providers::models_list,
            agent::providers::models_unavailable,
            agent::providers::models_reset_unavailable,
            harness::harness_send,
            harness::harness_cancel,
            procs::proc_spawn,
            procs::proc_write,
            procs::proc_kill,
            procs::which,
            browser::browser_init,
            browser::browser_create,
            browser::browser_set_bounds,
            browser::browser_navigate,
            browser::browser_history,
            browser::browser_close,
            browser::browser_devtools,
            browser::browser_console,
            browser::browser_clear_console,
            browser::browser_snapshot,
            browser::browser_serve,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Cepheus IDE");
}
