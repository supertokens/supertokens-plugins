import logging

from .types import RowndPluginConfig


_logger = logging.getLogger("supertokens_rownd")


def log_debug(config: RowndPluginConfig, message: str) -> None:
    if config.enable_debug_logs:
        # The plugin flag opts in; an INFO-configured application need not also enable DEBUG.
        _logger.info("RowndMigrationPlugin: %s", message)


def log_warning(config: RowndPluginConfig, message: str) -> None:
    _ = config
    _logger.warning("RowndMigrationPlugin: %s", message)
