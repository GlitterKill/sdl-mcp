/**
 * Controllers — primary C# fixture.
 * Defines controller class, interface, struct, and enum.
 */
namespace StressFixture.Controllers;

public enum HttpStatusCode
{
    Ok = 200,
    Created = 201,
    BadRequest = 400,
    NotFound = 404,
    InternalError = 500
}

public struct ApiResult<T>
{
    public T Data { get; set; }
    public HttpStatusCode Status { get; set; }
    public string Message { get; set; }

    public ApiResult(T data, HttpStatusCode status, string message)
    {
        Data = data;
        Status = status;
        Message = message;
    }
}

public interface IController
{
    string GetRoute();
    ApiResult<object> HandleGet(string id);
    ApiResult<object> HandlePost(object body);
    ApiResult<object> HandleDelete(string id);
}

public class UserDto
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string Email { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public class UserController : IController
{
    private readonly Dictionary<string, UserDto> _users = new();

    public string GetRoute() => "/api/users";

    public ApiResult<object> HandleGet(string id)
    {
        if (_users.TryGetValue(id, out var user))
            return new ApiResult<object>(user, HttpStatusCode.Ok, "Found");
        return new ApiResult<object>(null!, HttpStatusCode.NotFound, "User not found");
    }

    public ApiResult<object> HandlePost(object body)
    {
        var user = (UserDto)body;
        user.Id = Guid.NewGuid().ToString();
        user.CreatedAt = DateTime.UtcNow;
        _users[user.Id] = user;
        return new ApiResult<object>(user, HttpStatusCode.Created, "Created");
    }

    public ApiResult<object> HandleDelete(string id)
    {
        if (_users.Remove(id))
            return new ApiResult<object>(null!, HttpStatusCode.Ok, "Deleted");
        return new ApiResult<object>(null!, HttpStatusCode.NotFound, "Not found");
    }

    public int GetUserCount() => _users.Count;
}
