//! `zumi-evals --all | --only NAME[,NAME] | --list`. One JSON line per eval on stdout, then a summary line.
use zumi_evals::{all, exit_code, run};

fn main() -> std::process::ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let evals = all();
    if args.iter().any(|a| a == "--list") {
        for e in &evals {
            println!("{}\t{}", e.name, e.what);
        }
        return std::process::ExitCode::SUCCESS;
    }
    let only: Vec<String> = match args.iter().position(|a| a == "--only") {
        Some(i) => args.get(i + 1).map(|v| v.split(',').map(str::to_string).collect()).unwrap_or_default(),
        None => Vec::new(),
    };
    if !args.iter().any(|a| a == "--all") && only.is_empty() {
        eprintln!("usage: zumi-evals --all | --only NAME[,NAME] | --list");
        return std::process::ExitCode::from(2);
    }
    if let Some(bad) = only.iter().find(|o| !evals.iter().any(|e| e.name == o.as_str())) {
        eprintln!("no eval named {bad:?}");
        return std::process::ExitCode::from(2);
    }
    let results = run(&evals, &only);
    for r in &results {
        println!("{}", r.to_json());
    }
    let failed = results.iter().filter(|r| !r.ok).count();
    println!("{}", serde_json::json!({ "summary": { "ran": results.len(), "failed": failed } }));
    std::process::ExitCode::from(exit_code(&results) as u8)
}
