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
        env.storage().instance().get(&DataKey::Counter).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_increment_wrong_assertion() {
        let env = Env::default();
        let contract_id = env.register_contract(None, Counter);
        let client = CounterClient::new(&env, &contract_id);

        client.initialize(&0);
        client.increment();
        // Intentional failure: increment(0) = 1, but asserting 2
        assert_eq!(client.get(), 2);
    }
}
