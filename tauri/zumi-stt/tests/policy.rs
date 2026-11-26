//! R4b item 2 (GATE-OPUS-R4 should-fix 3): the settings are a code-execution and key-exfiltration surface unless they are
//! checked. `whisperExe` must be the known program, `keyEnv` a key name on the allow-list, `baseUrl` an origin the chosen
//! provider owns, or one the user added (which then takes only the dedicated key variable) through zumi-egress's rules.
mod common;
use common::*;
use serde_json::json;
use std::path::PathBuf;
use zumi_stt::policy::{Policy, USER_KEY_ENV};
use zumi_stt::settings::Settings;

fn settings(v: serde_json::Value) -> Settings {
    Settings::from_json(&v, std::env::temp_dir()).unwrap()
}
fn check(policy: &Policy, v: serde_json::Value) -> Result<(), &'static str> {
    policy.check(&settings(v)).map_err(|e| e.code())
}
fn no_exe_dirs() -> Policy {
    Policy { exe_dirs: Vec::new() }
}

/// `<tmp>/bin/whisper-cli.exe` (a stand-in file), the model beside it, and a policy that knows `<tmp>/bin`.
fn known_program(tag: &str) -> (Policy, PathBuf, PathBuf, PathBuf) {
    let dir = temp_dir(tag);
    let bin = dir.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let exe = bin.join("whisper-cli.exe");
    std::fs::write(&exe, b"x").unwrap();
    let model = dir.join("ggml-x.bin");
    std::fs::write(&model, b"x").unwrap();
    (Policy { exe_dirs: vec![bin.clone()] }, exe, model, bin)
}

#[test]
fn the_local_engine_runs_only_the_known_program() {
    let (policy, exe, model, bin) = known_program("pol-exe");
    let local = |exe: &std::path::Path| json!({"engine": "local", "whisperExe": exe, "whisperModel": model});
    assert_eq!(check(&policy, local(&exe)), Ok(()), "the program in a known folder");

    // Any other program, wherever it is.
    let other = bin.parent().unwrap().join("evil.exe");
    std::fs::write(&other, b"x").unwrap();
    assert_eq!(check(&policy, local(&other)), Err("stt_policy_exe"), "a program outside the known folders");
    let cmd = PathBuf::from(r"C:\Windows\System32\cmd.exe");
    assert_eq!(check(&policy, local(&cmd)), Err("stt_policy_exe"), "cmd.exe");
    assert_eq!(check(&no_exe_dirs(), local(&exe)), Err("stt_policy_exe"), "no known folder at all: nothing may run");

    // A known folder does not make every file in it the program: the name is fixed too.
    let renamed = bin.join("powershell.exe");
    std::fs::write(&renamed, b"x").unwrap();
    assert_eq!(check(&policy, local(&renamed)), Err("stt_policy_exe"), "another program in the known folder");
    // `..` out of the known folder, and a path that is not there.
    let sneaky = bin.join("..").join("whisper-cli.exe");
    std::fs::write(bin.parent().unwrap().join("whisper-cli.exe"), b"x").unwrap();
    assert_eq!(check(&policy, local(&sneaky)), Err("stt_policy_exe"), "a path that climbs out of the folder");
    assert_eq!(check(&policy, local(&bin.join("nope").join("whisper-cli.exe"))), Err("stt_policy_exe"), "a file that is not there");
}

#[test]
fn the_model_is_a_bin_file() {
    let (policy, exe, model, _) = known_program("pol-model");
    let with = |m: &std::path::Path| json!({"engine": "local", "whisperExe": exe, "whisperModel": m});
    assert_eq!(check(&policy, with(&model)), Ok(()));
    let script = model.with_file_name("model.ps1");
    std::fs::write(&script, b"x").unwrap();
    assert_eq!(check(&policy, with(&script)), Err("stt_policy_model"));
}

#[test]
fn a_key_name_must_be_on_the_list_and_no_other_variable_is_ever_named() {
    let p = no_exe_dirs();
    for (engine, name) in [("fish", "FISH_API_KEY"), ("elevenlabs", "ELEVENLABS_API_KEY"), ("deepseek", "DEEPSEEK_API_KEY"), ("openai", "OPENAI_API_KEY"), ("groq", "GROQ_API_KEY")] {
        assert_eq!(check(&p, json!({"engine": engine, "keyEnv": name})), Ok(()), "{engine} {name}");
        assert_eq!(check(&p, json!({"engine": engine, "keyEnv": USER_KEY_ENV})), Ok(()), "{engine} takes the dedicated variable too");
    }
    for bad in ["PATH", "USERPROFILE", "COMPUTERNAME", "ANTHROPIC_API_KEY", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "zumi_stt_api_key"] {
        assert_eq!(check(&p, json!({"engine": "openai", "keyEnv": bad})), Err("stt_policy_key"), "{bad}");
    }
    // A provider's own key name is not another provider's.
    assert_eq!(check(&p, json!({"engine": "groq", "keyEnv": "OPENAI_API_KEY"})), Err("stt_policy_key"));
}

#[test]
fn a_provider_key_goes_only_to_that_providers_origin() {
    let p = no_exe_dirs();
    let openai = |base: &str, key: &str| check(&p, json!({"engine": "openai", "keyEnv": key, "baseUrl": base}));
    assert_eq!(openai("https://api.openai.com/v1", "OPENAI_API_KEY"), Ok(()), "its own origin");
    assert_eq!(openai("https://api.openai.com", "OPENAI_API_KEY"), Ok(()));
    for evil in ["https://evil.example/v1", "https://api.openai.com.evil.test/v1", "https://api.openai.com@evil.test/v1", "https://evil.test/https://api.openai.com", "http://api.openai.com/v1", "https://api.openai.com:8443/v1"] {
        assert!(openai(evil, "OPENAI_API_KEY").is_err(), "{evil} must not get OPENAI_API_KEY");
    }
    assert_eq!(openai("https://evil.example/v1", "OPENAI_API_KEY"), Err("stt_policy_origin"));
}

#[test]
fn an_origin_the_user_added_takes_only_the_dedicated_key_and_zumi_egress_rules_still_apply() {
    let p = no_exe_dirs();
    let own = |base: &str| check(&p, json!({"engine": "openai", "keyEnv": USER_KEY_ENV, "baseUrl": base}));
    assert_eq!(own("https://stt.my-gateway.example/v1"), Ok(()), "a public https gateway the user typed");
    assert_eq!(own("http://127.0.0.1:8080/v1"), Ok(()), "a server on this PC");
    assert_eq!(own("http://stt.my-gateway.example/v1"), Err("egress_scheme"), "plain http to a public host");
    assert_eq!(own("https://10.0.0.5/v1"), Err("egress_private"), "a private address");
    assert_eq!(own("https://user:pw@stt.my-gateway.example/v1"), Err("egress_userinfo"));
    assert_eq!(own("not a url"), Err("egress_bad_url"));
}

#[test]
fn the_model_name_is_a_name_not_text() {
    let p = no_exe_dirs();
    let with = |m: &str| check(&p, json!({"engine": "groq", "keyEnv": "GROQ_API_KEY", "model": m}));
    assert_eq!(with("whisper-large-v3-turbo"), Ok(()));
    assert_eq!(with("scribe_v2"), Ok(()));
    for bad in ["a b", "x\r\ny", "model\"; rm", &"m".repeat(100)] {
        assert_eq!(with(bad), Err("stt_settings_bad"), "{bad:?}");
    }
}

#[test]
fn no_stt_chord_is_a_chord_the_hands_may_send() {
    // GATE-OPUS-R4 should-fix 4: the hands' `key` verb is a closed list; none of it may ever be a push-to-talk chord, or the
    // model could start the microphone. RegisterHotKey cannot tell an injected key from a real one.
    let rails = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../zumi-hands/src/rails.rs")).unwrap();
    let start = rails.find("pub const CHORDS").expect("the hands chord list");
    let list = &rails[start..start + rails[start..].find("];").unwrap()];
    let hands: Vec<String> = list.split('"').skip(1).step_by(2).map(str::to_string).collect();
    assert!(hands.len() >= 10, "{hands:?}");
    assert!(!hands.iter().any(|h| h.contains("space") || h.contains("alt+")), "the hands list has a space or alt chord: {hands:?}");
    for c in zumi_stt::hotkey::chords() {
        assert!(!hands.contains(&c.label.to_ascii_lowercase()), "{} is on the hands list", c.label);
    }
}
