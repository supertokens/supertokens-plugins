from unittest.mock import Mock

import pytest
from docker.errors import APIError, NotFound
from testcontainers.core.container import DockerContainer

from conftest import start_container


ROOTLESS_COLLISION = (
    "failed to set up container networking: driver failed programming external connectivity: "
    "error while calling PortManager.AddPort(): listen tcp4 0.0.0.0:44492: bind: address already in use"
)


def container_double(error=None):
    container = Mock(spec=DockerContainer)
    container.with_name.return_value = container
    container.start.side_effect = error
    return container


def assert_failed_attempt_cleaned(container):
    name = container.with_name.call_args.args[0]
    client = container.get_docker_client.return_value.client
    client.containers.get.assert_called_once_with(name)
    client.containers.get.return_value.remove.assert_called_once_with(force=True, v=True)
    client.close.assert_called_once_with()


@pytest.mark.parametrize("explanation", [
    ROOTLESS_COLLISION,
    "driver failed programming external connectivity: Bind for 0.0.0.0:44492 failed: port is already allocated",
])
def test_port_collision_cleans_failed_attempt_before_starting_fresh_container(explanation):
    failed = container_double(APIError("start failed", explanation=explanation))
    successful = container_double()

    def next_container():
        if factory.call_count == 1:
            return failed
        assert_failed_attempt_cleaned(failed)
        return successful

    factory = Mock(side_effect=next_container)
    assert start_container(factory) is successful
    assert factory.call_count == 2
    failed.start.assert_called_once_with()
    successful.start.assert_called_once_with()
    assert failed.with_name.call_args != successful.with_name.call_args
    successful.get_docker_client.assert_not_called()


def test_port_collision_stops_after_three_cleaned_attempts():
    errors = [APIError("start failed", explanation=ROOTLESS_COLLISION) for _ in range(3)]
    containers = [container_double(error) for error in errors]
    factory = Mock(side_effect=containers)

    with pytest.raises(APIError) as raised:
        start_container(factory)

    assert raised.value is errors[-1]
    assert factory.call_count == 3
    for container in containers:
        assert_failed_attempt_cleaned(container)
    assert len({container.with_name.call_args.args[0] for container in containers}) == 3


@pytest.mark.parametrize("error", [
    APIError("start failed", explanation="permission denied"),
    APIError("start failed", explanation="failed to set up container networking: network not found"),
    APIError("start failed", explanation="address already in use"),
    TimeoutError("Timed out waiting for log message"),
    RuntimeError(ROOTLESS_COLLISION),
])
def test_other_start_or_readiness_errors_are_cleaned_without_retry(error):
    container = container_double(error)
    factory = Mock(return_value=container)

    with pytest.raises(type(error)) as raised:
        start_container(factory)

    assert raised.value is error
    factory.assert_called_once_with()
    assert_failed_attempt_cleaned(container)


def test_failure_before_creation_closes_client_and_preserves_error():
    error = APIError("image pull failed")
    container = container_double(error)
    client = container.get_docker_client.return_value.client
    client.containers.get.side_effect = NotFound("no container created")
    factory = Mock(return_value=container)

    with pytest.raises(APIError) as raised:
        start_container(factory)

    assert raised.value is error
    factory.assert_called_once_with()
    client.close.assert_called_once_with()


def test_cleanup_failure_closes_client_without_starting_another_container():
    container = container_double(APIError("start failed", explanation=ROOTLESS_COLLISION))
    client = container.get_docker_client.return_value.client
    cleanup_error = APIError("remove failed")
    client.containers.get.return_value.remove.side_effect = cleanup_error
    factory = Mock(return_value=container)

    with pytest.raises(APIError) as raised:
        start_container(factory)

    assert raised.value is cleanup_error
    factory.assert_called_once_with()
    client.close.assert_called_once_with()
