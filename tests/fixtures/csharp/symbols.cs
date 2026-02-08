using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace MyApp.Controllers
{
    public class UsersController
    {
        private readonly ILogger _logger;

        public UsersController(ILogger logger)
        {
            _logger = logger;
        }

        public async Task<ActionResult> GetUser(int id)
        {
            var user = await _userService.GetUserByIdAsync(id);
            return Ok(user);
        }

        protected internal void LogInfo(string message)
        {
            _logger.LogInformation(message);
        }

        public string Name { get; set; }

        private int _count;
    }

    internal class InternalService
    {
        public void Process()
        {
        }
    }
}

namespace MyApp.Services
{
    public interface IUserService
    {
        Task<User> GetUserByIdAsync(int id);
    }

    public struct Point
    {
        public int X { get; }
        public int Y { get; }

        public Point(int x, int y)
        {
            X = x;
            Y = y;
        }
    }

    public enum Status
    {
        Active,
        Inactive,
        Pending
    }

    public record User(int Id, string Name);

    public partial class PartialClass
    {
        public void Method1() { }
    }

    public partial class PartialClass
    {
        public void Method2() { }
    }
}
