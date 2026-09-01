from typing import Literal


class RowndPluginError(Exception):
    pass


class RowndEmailChangeError(Exception):
    def __init__(
        self,
        code: Literal["CONFLICT", "AMBIGUOUS", "INVALID_EMAIL"],
        http_status: int,
        message: str,
    ):
        super().__init__(message)
        self.code = code
        self.http_status = http_status
