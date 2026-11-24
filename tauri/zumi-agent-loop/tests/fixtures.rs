//! Every file under fixtures/ must load as a mock transport (a broken fixture fails here, not in a goal run).
use std::collections::HashMap;

#[test]
fn every_fixture_loads() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures");
    let mut n = 0;
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.extension().is_some_and(|x| x == "json") {
            zumi_agent_loop::transport::MockTransport::load(&p, HashMap::new()).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
            n += 1;
        }
    }
    assert!(n >= 1, "no fixtures found");
}
