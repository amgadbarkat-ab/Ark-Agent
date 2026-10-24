//! The parts of the shell that are worth testing without a window around them.
pub mod acquire;
pub mod ask;
pub mod bridge;
pub mod deployment;
pub mod deployment_release;
pub mod engine;
pub mod env;
pub mod harness;
pub mod host_access;
pub mod install;
pub mod llama_runtime;
pub mod local_model;
pub mod local_server;
pub mod local_setup;
pub mod preparation;
pub mod problem;
pub mod provider;
pub mod provider_oauth;
pub mod pull_metrics;
pub mod quiet;
pub mod retired_plan;
pub mod saved_intent;
pub mod stack;
pub mod supervise;
pub mod tray;
pub mod vault;
pub mod windows;

#[cfg(test)]
pub(crate) mod test_support;
