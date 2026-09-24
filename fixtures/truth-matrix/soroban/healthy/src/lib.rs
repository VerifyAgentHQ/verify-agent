#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Env, Symbol};

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
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn test_initialize_and_get() {
        let env = Env::default();
        let contract_id = env.register_contract(None, Counter);
        let client = CounterClient::new(&env, &contract_id);

        client.initialize(&10);
        assert_eq!(client.get(), 10);
    }

    #[test]
    fn test_increment() {
        let env = Env::default();
        let contract_id = env.register_contract(None, Counter);
        let client = CounterClient::new(&env, &contract_id);

        client.initialize(&0);
        assert_eq!(client.increment(), 1);
        assert_eq!(client.increment(), 2);
        assert_eq!(client.increment(), 3);
        assert_eq!(client.get(), 3);
    }

    #[test]
    fn test_increment_from_initial_value() {
        let env = Env::default();
        let contract_id = env.register_contract(None, Counter);
        let client = CounterClient::new(&env, &contract_id);

        client.initialize(&5);
        assert_eq!(client.increment(), 6);
        assert_eq!(client.get(), 6);
    }
}
