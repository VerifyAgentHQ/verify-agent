#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Env};

#[contracttype]
pub enum DataKey {
    Counter,
}

#[contract]
pub struct Counter;

#[contractimpl]
impl Counter {
    pub fn initialize(env: Env, value: i32) {
        env.storage().instance().set(&DataKey::Counter, &value);
    }

    pub fn increment(env: Env) -> i32 {
        let mut val: i32 = env.storage().instance().get(&DataKey::Counter).unwrap_or(0);
        val += 1;
        env.storage().instance().set(&DataKey::Counter, &val);
        val
    }

    pub fn get(env: Env) -> i32 {
        // Intentional type error: assigning String to i32
        let result: String = env.storage().instance().get(&DataKey::Counter).unwrap_or(0);
        result
    }
}
