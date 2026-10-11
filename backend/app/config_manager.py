import json
import os

CONFIG_FILE = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "config.json")

def load_config() -> dict:
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}

def save_config(config_data: dict) -> bool:
    try:
        os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)
        current = load_config()
        current.update(config_data)
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(current, f, indent=4)
        return True
    except Exception:
        return False

def load_user_config(user_id: str) -> dict:
    config = load_config()
    users = config.get("users", {})
    return users.get(user_id, {})

def save_user_config(user_id: str, user_data: dict) -> bool:
    config = load_config()
    if "users" not in config:
        config["users"] = {}
    config["users"][user_id] = user_data
    return save_config(config)

def get_current_user() -> str:
    config = load_config()
    return config.get("current_user", "")

def set_current_user(user_id: str) -> bool:
    config = load_config()
    config["current_user"] = user_id
    return save_config(config)

def get_all_users() -> dict:
    config = load_config()
    return config.get("users", {})

def delete_user(user_id: str) -> bool:
    config = load_config()
    users = config.get("users", {})
    if user_id in users:
        del users[user_id]
        config["users"] = users
        if config.get("current_user") == user_id:
            config["current_user"] = ""
        return save_config(config)
    return False
