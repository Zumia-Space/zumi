//! zumi-packs (T-31-MAUS R7, K0a): the power-pack mechanism for the owner build. A pack is a Zumia-made helper exe plus a manifest that
//! declares what it may do (`manifest`); the host decides each request against that scope and the user's grants (`scope`), through one
//! door that writes the audit line first (`broker`, `audit`). Nothing here depends on tauri.
//!
//! K0b (crate allow-list CI, timed Accept, typed pack name, signing) belongs to the public gate and is not here.
pub mod audit;
pub mod broker;
pub mod consent;
pub mod job;
pub mod manifest;
pub mod packs;
pub mod proc;
pub mod scope;
pub mod skills;
