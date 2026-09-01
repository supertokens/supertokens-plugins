from .types import RowndPluginConfig


def log_debug(config: RowndPluginConfig, message: str) -> None:
    if config.enable_debug_logs:
        print("RowndMigrationPlugin: %s" % message)
