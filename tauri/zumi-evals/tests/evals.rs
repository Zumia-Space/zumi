//! R7 K1: `zumi-evals --all` runs every earlier phase's fixture set and the pack and skill checks, and says which hold.
use zumi_evals::{all, exit_code, run, Eval};

const WANTED: [&str; 7] = ["fixtures_load", "injection_set", "skill_t50", "skill_orders", "canary_scope_in_process", "consent_forgery", "audit_chain"];

#[test]
fn the_registry_holds_the_checks_of_the_earlier_phases_and_of_k0_k1() {
    let names: Vec<&str> = all().iter().map(|e| e.name).collect();
    for want in WANTED {
        assert!(names.contains(&want), "{want} is missing from {names:?}");
    }
    let mut sorted = names.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(sorted.len(), names.len(), "a name is used twice");
}

#[test]
fn all_runs_and_every_eval_holds() {
    let results = run(&all(), &[]);
    assert!(results.len() >= WANTED.len());
    let failed: Vec<_> = results.iter().filter(|r| !r.ok).map(|r| format!("{}: {}", r.name, r.detail)).collect();
    assert!(failed.is_empty(), "{failed:?}");
    assert_eq!(exit_code(&results), 0);
}

#[test]
fn bite_a_failing_eval_a_panicking_eval_and_an_empty_run_are_all_exit_1() {
    fn bad() -> Result<(), String> {
        Err("nope".into())
    }
    fn boom() -> Result<(), String> {
        panic!("exploded")
    }
    fn fine() -> Result<(), String> {
        Ok(())
    }
    let evals = [Eval { name: "bad", what: "", run: bad }, Eval { name: "boom", what: "", run: boom }, Eval { name: "fine", what: "", run: fine }];
    let results = run(&evals, &[]);
    assert_eq!(results.iter().map(|r| r.ok).collect::<Vec<_>>(), vec![false, false, true]);
    assert!(results[1].detail.contains("exploded"));
    assert_eq!(exit_code(&results), 1);
    assert_eq!(exit_code(&run(&evals, &["fine".to_string()])), 0, "only the eval that held was asked for");
    assert_eq!(exit_code(&run(&evals, &["nothing-by-this-name".to_string()])), 1, "running nothing is not a pass");
    assert_eq!(exit_code(&[]), 1);
}
